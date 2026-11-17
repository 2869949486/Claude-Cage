import CoreMedia
import CoreVideo
import Foundation
import VideoToolbox

struct MacWindowVideoFrame {
    let data: Data
    let key: Bool
    // The decoder configuration (avcC) accompanies every key frame.
    let config: Data?
    let edge: String?
    let corner: Int
}

// One encoder belongs to one frame connection. Each frame it produces is sent
// to that connection's decoder in order, so the two never disagree about the
// reference picture. A new connection starts with a key frame.
final class MacWindowVideoEncoder: @unchecked Sendable {
    // After the window stops changing, the same surface is encoded this many
    // more times so that text reaches full sharpness.
    static let refinements = 2
    private static let marker = "+q"

    private var session: VTCompressionSession?
    private var width = 0, height = 0, identity = ""
    private var count: Int64 = 0
    private var edge: String?
    private var corner = 0
    private(set) var failed = false

    deinit { close() }

    func close() {
        if let session { VTCompressionSessionInvalidate(session) }
        session = nil
    }

    func fail() { failed = true; close() }

    // "generation-12+q1" is the first refinement of stream frame 12.
    static func split(_ sequence: String?) -> (base: String?, level: Int) {
        guard let sequence, let range = sequence.range(of: marker, options: .backwards),
              let level = Int(sequence[range.upperBound...]), level > 0 else { return (sequence, 0) }
        return (String(sequence[..<range.lowerBound]), level)
    }

    static func refined(_ sequence: String, level: Int) -> String { sequence + marker + String(level) }

    private func open(width: Int, height: Int) throws -> VTCompressionSession {
        close()
        var created: VTCompressionSession?
        // Low-latency rate control emits each frame as soon as it is submitted
        // and holds the bitrate more closely. Fall back to the default encoder.
        for lowLatency in [true, false] {
            let specification: CFDictionary? = lowLatency
                ? [kVTVideoEncoderSpecification_EnableLowLatencyRateControl: true] as [CFString: Any] as CFDictionary : nil
            let status = VTCompressionSessionCreate(allocator: nil, width: Int32(width), height: Int32(height),
                                                    codecType: kCMVideoCodecType_H264, encoderSpecification: specification,
                                                    imageBufferAttributes: nil, compressedDataAllocator: nil,
                                                    outputCallback: nil, refcon: nil, compressionSessionOut: &created)
            if status == noErr, created != nil { break }
            created = nil
        }
        guard let session = created else { throw Failure(8, "video_encoder_unavailable") }
        // Text needs far more bits than film. The link is local, so the cap is
        // generous; an unchanged window still costs almost nothing.
        let bitrate = min(24_000_000, max(4_000_000, width * height * 3))
        let properties: [(CFString, CFTypeRef)] = [
            (kVTCompressionPropertyKey_RealTime, kCFBooleanTrue),
            (kVTCompressionPropertyKey_AllowFrameReordering, kCFBooleanFalse),
            (kVTCompressionPropertyKey_ExpectedFrameRate, NSNumber(value: 30)),
            (kVTCompressionPropertyKey_MaxKeyFrameInterval, NSNumber(value: 600)),
            (kVTCompressionPropertyKey_AverageBitRate, NSNumber(value: bitrate)),
            (kVTCompressionPropertyKey_ProfileLevel, kVTProfileLevel_H264_High_AutoLevel),
        ]
        // An encoder may not know every property; the ones it accepts suffice.
        for (key, value) in properties { _ = VTSessionSetProperty(session, key: key, value: value) }
        VTCompressionSessionPrepareToEncodeFrames(session)
        return session
    }

    // A window's rounded corners are transparent in the capture and black once
    // encoded. Report their size and the colour just inside the bottom edge so
    // the viewer can fill them as the still-image path does.
    private func surround(_ buffer: CVPixelBuffer) -> (String?, Int) {
        guard CVPixelBufferGetPixelFormatType(buffer) == kCVPixelFormatType_32BGRA,
              CVPixelBufferLockBaseAddress(buffer, .readOnly) == kCVReturnSuccess else { return (nil, 0) }
        defer { CVPixelBufferUnlockBaseAddress(buffer, .readOnly) }
        let width = CVPixelBufferGetWidth(buffer), height = CVPixelBufferGetHeight(buffer)
        let row = CVPixelBufferGetBytesPerRow(buffer)
        guard width > 40, height > 40, row >= width * 4, let base = CVPixelBufferGetBaseAddress(buffer) else { return (nil, 0) }
        let bytes = base.assumingMemoryBound(to: UInt8.self)
        let last = bytes + (height - 1) * row
        var corner = 0
        while corner < min(96, width / 4), last[corner * 4 + 3] < 255 { corner += 1 }
        let pixel = bytes + (height - 17) * row + 16 * 4
        let edge = pixel[3] == 255 ? String(format: "#%02x%02x%02x", pixel[2], pixel[1], pixel[0]) : nil
        return (edge, corner)
    }

    private func configuration(_ sample: CMSampleBuffer) throws -> Data {
        guard let description = CMSampleBufferGetFormatDescription(sample) else { throw Failure(8, "video_encoder_unavailable") }
        let atoms = CMFormatDescriptionGetExtension(description, extensionKey: kCMFormatDescriptionExtension_SampleDescriptionExtensionAtoms) as? [String: Any]
        if let record = atoms?["avcC"] as? Data, record.count >= 7, record[0] == 1, record[4] & 3 == 3 { return record }
        // Build the record from the parameter sets when the atom is absent.
        var sets: [[UInt8]] = []
        var total = 0
        var headerLength: Int32 = 0
        var index = 0
        repeat {
            var pointer: UnsafePointer<UInt8>?
            var size = 0
            guard CMVideoFormatDescriptionGetH264ParameterSetAtIndex(description, parameterSetIndex: index, parameterSetPointerOut: &pointer,
                                                                     parameterSetSizeOut: &size, parameterSetCountOut: &total,
                                                                     nalUnitHeaderLengthOut: &headerLength) == noErr,
                  let pointer, size > 0, size < 65536 else { throw Failure(8, "video_encoder_unavailable") }
            sets.append(Array(UnsafeBufferPointer(start: pointer, count: size)))
            index += 1
        } while index < total
        let sequence = sets.filter { $0[0] & 0x1f == 7 }, picture = sets.filter { $0[0] & 0x1f == 8 }
        guard headerLength == 4, let first = sequence.first, first.count >= 4, sequence.count < 32, !picture.isEmpty, picture.count < 256 else {
            throw Failure(8, "video_encoder_unavailable")
        }
        var record = Data([1, first[1], first[2], first[3], 0xff, 0xe0 | UInt8(sequence.count)])
        for set in sequence { record.append(contentsOf: [UInt8(set.count >> 8), UInt8(set.count & 0xff)]); record.append(contentsOf: set) }
        record.append(UInt8(picture.count))
        for set in picture { record.append(contentsOf: [UInt8(set.count >> 8), UInt8(set.count & 0xff)]); record.append(contentsOf: set) }
        return record
    }

    private final class Completion: @unchecked Sendable {
        private let lock = NSLock()
        private var continuation: CheckedContinuation<CMSampleBuffer, Error>?
        init(_ continuation: CheckedContinuation<CMSampleBuffer, Error>) { self.continuation = continuation }
        func finish(_ result: Result<CMSampleBuffer, Error>) {
            lock.lock()
            let pending = continuation
            continuation = nil
            lock.unlock()
            pending?.resume(with: result)
        }
    }

    func encode(_ buffer: CVPixelBuffer, identity next: String, forceKey: Bool) async throws -> MacWindowVideoFrame {
        let bufferWidth = CVPixelBufferGetWidth(buffer), bufferHeight = CVPixelBufferGetHeight(buffer)
        guard bufferWidth >= 16, bufferHeight >= 16 else { throw Failure(8, "video_encoder_unavailable") }
        if session == nil || bufferWidth != width || bufferHeight != height || next != identity {
            session = try open(width: bufferWidth, height: bufferHeight)
            width = bufferWidth; height = bufferHeight; identity = next
            (edge, corner) = surround(buffer)
        }
        guard let session else { throw Failure(8, "video_encoder_unavailable") }
        let time = CMTime(value: count, timescale: 30)
        count += 1
        let options: CFDictionary? = forceKey ? [kVTEncodeFrameOptionKey_ForceKeyFrame: true] as [CFString: Any] as CFDictionary : nil
        let sample: CMSampleBuffer = try await withCheckedThrowingContinuation { continuation in
            let completion = Completion(continuation)
            let status = VTCompressionSessionEncodeFrame(session, imageBuffer: buffer, presentationTimeStamp: time,
                                                         duration: CMTime(value: 1, timescale: 30), frameProperties: options,
                                                         infoFlagsOut: nil) { status, _, output in
                if status == noErr, let output { completion.finish(.success(output)) }
                else { completion.finish(.failure(Failure(8, "video_encoder_unavailable"))) }
            }
            if status != noErr { completion.finish(.failure(Failure(8, "video_encoder_unavailable"))); return }
            // Only one frame is ever in flight; ask for it now rather than
            // letting the encoder hold it for a later one.
            if VTCompressionSessionCompleteFrames(session, untilPresentationTimeStamp: time) != noErr {
                completion.finish(.failure(Failure(8, "video_encoder_unavailable")))
            }
        }
        guard let block = CMSampleBufferGetDataBuffer(sample) else { throw Failure(8, "video_encoder_unavailable") }
        let length = CMBlockBufferGetDataLength(block)
        guard length > 4, length < 8 << 20 else { throw Failure(8, "frame_limit") }
        var data = Data(count: length)
        let copied = data.withUnsafeMutableBytes { bytes -> OSStatus in
            guard let address = bytes.baseAddress else { return -1 }
            return CMBlockBufferCopyDataBytes(block, atOffset: 0, dataLength: length, destination: address)
        }
        guard copied == noErr else { throw Failure(8, "video_encoder_unavailable") }
        let attachments = CMSampleBufferGetSampleAttachmentsArray(sample, createIfNecessary: false) as? [[CFString: Any]]
        let key = attachments?.first?[kCMSampleAttachmentKey_NotSync] as? Bool != true
        return MacWindowVideoFrame(data: data, key: key, config: key ? try configuration(sample) : nil, edge: edge, corner: corner)
    }
}
