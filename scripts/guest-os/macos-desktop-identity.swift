import AppKit
import Darwin

// LaunchServices owns the signed Desktop process. Its public --stdout option
// connects the native account provider to a private FIFO on a cold launch.
@MainActor
enum MacDesktopIdentity {
    private static var reader: Process?
    private static var owner: pid_t = 0
    private static var lastCompleted: [String: Any]?
    private static var result: URL?
    private static var starting: Task<Void, Error>?

    static func start(_ app: URL) async throws {
        if let starting { try await starting.value; return }
        let task = Task { @MainActor in try await coldStart(app) }
        starting = task
        defer { starting = nil }
        try await task.value
    }

    private static func coldStart(_ app: URL) async throws {
        do {
            _ = try claudePIDs()
            return
        } catch let error as Failure where error.code == 3 {
            // The verified app is not yet running; only a cold launch can be observed.
        }
        guard let parser = Bundle.main.url(forResource: "desktop-identity", withExtension: "py") else { return }
        let python = URL(fileURLWithPath: "/usr/local/libexec/cage-cli/bin/python3")
        guard FileManager.default.isExecutableFile(atPath: python.path) else { return }
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
        let fifo = root.appendingPathComponent("stream").path
        let file = root.appendingPathComponent("account.json")
        var captured = false
        defer { if !captured { try? FileManager.default.removeItem(at: root) } }
        guard mkfifo(fifo, 0o600) == 0 else { return }
        let fd = Darwin.open(fifo, O_RDONLY | O_NONBLOCK | O_CLOEXEC)
        guard fd >= 0 else { return }
        let input = FileHandle(fileDescriptor: fd, closeOnDealloc: true)
        let keeper = Darwin.open(fifo, O_WRONLY | O_CLOEXEC)
        guard keeper >= 0 else { return }
        defer { Darwin.close(keeper) }
        guard fcntl(fd, F_SETFL, 0) != -1 else { return }
        let sink = Process()
        sink.executableURL = python
        sink.arguments = ["-I", parser.path, file.path]
        sink.standardInput = input
        sink.standardError = FileHandle.nullDevice
        sink.standardOutput = FileHandle.nullDevice
        sink.terminationHandler = { ended in
            Task { @MainActor in
                if reader === ended {
                    lastCompleted = readPublicIdentity(file)
                    reader = nil
                    result = nil
                }
                try? FileManager.default.removeItem(at: root)
            }
        }
        try sink.run()
        let launch = Process()
        launch.executableURL = URL(fileURLWithPath: "/usr/bin/open")
        launch.arguments = ["-a", app.path, "--stdout", fifo, "--env", "DESKTOP_LOG_LEVEL=debug",
                            "--env", "CLAUDE_ENABLE_LOGGING=1", "--env", "DEBUG=*current-account*"]
        launch.standardOutput = FileHandle.nullDevice
        launch.standardError = FileHandle.nullDevice
        try launch.run()
        let deadline = ProcessInfo.processInfo.systemUptime + 45
        while launch.isRunning && ProcessInfo.processInfo.systemUptime < deadline {
            try await Task.sleep(nanoseconds: 50_000_000)
        }
        if launch.isRunning { launch.terminate(); return }
        guard launch.terminationStatus == 0 else { return }
        var launchedPID: pid_t?
        for _ in 0..<40 {
            if let pid = try? claudePIDs().first { launchedPID = pid; break }
            try await Task.sleep(nanoseconds: 50_000_000)
        }
        guard let pid = launchedPID else { return }
        Darwin.unlink(fifo)
        if reader?.isRunning == true { reader?.terminate() }
        lastCompleted = nil
        reader = sink
        owner = pid
        result = file
        captured = true
    }

    static func current(for pids: Set<pid_t>) -> [String: Any]? {
        if pids.isEmpty { return lastCompleted }
        guard pids.contains(owner), reader?.isRunning == true, let result else { return nil }
        return readPublicIdentity(result)
    }

    private static func readPublicIdentity(_ result: URL) -> [String: Any]? {
        guard let input = try? FileHandle(forReadingFrom: result) else { return nil }
        defer { try? input.close() }
        guard let data = try? input.read(upToCount: 4097), data.count <= 4096,
              let value = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              value["logged_in"] is Bool else { return nil }
        return value
    }
}
