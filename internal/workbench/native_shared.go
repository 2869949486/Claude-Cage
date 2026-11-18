package workbench

import (
	"encoding/binary"
	"errors"
	"io"
)

// Helpers the macOS guest shared with the removed Windows guest.

func writeWindowsAttachmentFrames(output io.Writer, input io.Reader) error {
	buffer := make([]byte, 64<<10)
	header := make([]byte, 4)
	var count int64
	for {
		n, err := input.Read(buffer)
		count += int64(n)
		if count > browserFileLimit {
			return errors.New("每个文件不能超过 2 GB")
		}
		if n > 0 {
			binary.LittleEndian.PutUint32(header, uint32(n))
			if writeErr := writeWindowsAttachmentPart(output, header); writeErr != nil {
				return writeErr
			}
			if writeErr := writeWindowsAttachmentPart(output, buffer[:n]); writeErr != nil {
				return writeErr
			}
		}
		if err != nil {
			if err != io.EOF {
				return err
			}
			break
		}
	}
	return writeWindowsAttachmentPart(output, []byte{0, 0, 0, 0})
}

func writeWindowsAttachmentPart(output io.Writer, data []byte) error {
	for len(data) != 0 {
		n, err := output.Write(data)
		if err != nil {
			return err
		}
		if n <= 0 || n > len(data) {
			return io.ErrShortWrite
		}
		data = data[n:]
	}
	return nil
}
