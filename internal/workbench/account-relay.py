"""Linux namespace edge. The only uplink is a controller-created Unix socket."""

import asyncio
import os
import socket
import struct
import sys

UPSTREAM = sys.argv[1]
MAX_DNS = 65535
slots = asyncio.Semaphore(96)


async def upstream(header, payload=b""):
    reader, writer = await asyncio.open_unix_connection(UPSTREAM)
    try:
        writer.write(header + payload)
        await writer.drain()
        reply = await asyncio.wait_for(reader.readuntil(b"\r\n\r\n"), 28)
        if not reply.startswith(b"HTTP/1.1 200 "):
            raise ConnectionError("route unavailable")
        return reader, writer, reply
    except BaseException:
        writer.close()
        raise


async def copy(source, destination):
    while data := await source.read(65536):
        destination.write(data)
        await destination.drain()
    destination.write_eof()


async def tcp(reader, writer):
    remote = None
    try:
        if slots.locked():
            return
        async with slots:
            # Linux SO_ORIGINAL_DST returns the sockaddr before OUTPUT redirection.
            target = writer.get_extra_info("socket").getsockopt(socket.SOL_IP, 80, 16)
            address = socket.inet_ntoa(target[4:8])
            port = int.from_bytes(target[2:4], "big")
            dest = f"{address}:{port}"
            incoming, remote, _ = await upstream(
                f"CONNECT {dest} HTTP/1.1\r\nHost: {dest}\r\n\r\n".encode()
            )
            tasks = [
                asyncio.create_task(copy(reader, remote)),
                asyncio.create_task(copy(incoming, writer)),
            ]
            try:
                await asyncio.gather(*tasks)
            finally:
                for task in tasks:
                    task.cancel()
                await asyncio.gather(*tasks, return_exceptions=True)
    except (OSError, ValueError, asyncio.IncompleteReadError, asyncio.TimeoutError):
        pass
    finally:
        if remote:
            remote.close()
        writer.close()


async def dns(query):
    if not query or len(query) > MAX_DNS or slots.locked():
        raise ValueError("invalid DNS request")
    async with slots:
        header = f"POST /dns HTTP/1.1\r\nHost: resolver\r\nConnection: close\r\nContent-Length: {len(query)}\r\n\r\n".encode()
        reader, writer, _ = await upstream(header, query)
        try:
            return await asyncio.wait_for(read_dns(reader), 25)
        finally:
            writer.close()


async def read_dns(reader):
    data = bytearray()
    while part := await reader.read(4096):
        data.extend(part)
        if len(data) > MAX_DNS:
            raise ValueError("oversized DNS answer")
    return bytes(data)


class UDP(asyncio.DatagramProtocol):
    def connection_made(self, transport):
        self.transport = transport

    def datagram_received(self, data, peer):
        if not slots.locked():
            asyncio.create_task(self.reply(data, peer))

    async def reply(self, data, peer):
        try:
            self.transport.sendto(await dns(data), peer)
        except (OSError, ValueError, asyncio.TimeoutError, asyncio.IncompleteReadError):
            pass


async def dns_tcp(reader, writer):
    try:
        size = int.from_bytes(await asyncio.wait_for(reader.readexactly(2), 5), "big")
        reply = await dns(await asyncio.wait_for(reader.readexactly(size), 5))
        writer.write(struct.pack("!H", len(reply)) + reply)
        await writer.drain()
    except (OSError, ValueError, asyncio.IncompleteReadError, asyncio.TimeoutError):
        pass
    finally:
        writer.close()


async def main():
    loop = asyncio.get_running_loop()
    await loop.create_datagram_endpoint(UDP, local_addr=("127.0.0.1", 53))
    servers = [
        await asyncio.start_server(dns_tcp, "127.0.0.1", 53),
        await asyncio.start_server(tcp, "127.0.0.1", 15301),
    ]
    ended = asyncio.Event()

    def controller():
        if not os.read(0, 64):
            ended.set()

    loop.add_reader(0, controller)
    print("ready", os.getpid(), flush=True)
    while not ended.is_set():
        try:
            await asyncio.wait_for(ended.wait(), 90)
        except asyncio.TimeoutError:
            inode = os.stat("/proc/self/ns/net").st_ino
            for pid in os.listdir("/proc"):
                if not pid.isdecimal() or int(pid) == os.getpid():
                    continue
                try:
                    if os.stat(f"/proc/{pid}/ns/net").st_ino == inode:
                        break
                except OSError:
                    continue
            else:
                break
    for server in servers:
        server.close()


asyncio.run(main())
