package bridge

import (
	"bufio"
	"fmt"
	"io"
	"strings"
)

// ReadSSE keeps CRLF and UTF-8 intact across arbitrary transport chunks.
func ReadSSE(r io.Reader, limit int64, event func(string, string) error) error {
	b := bufio.NewReader(r)
	var line strings.Builder
	var data []string
	name := "message"
	var total int64
	dispatch := func() error {
		if len(data) == 0 {
			name = "message"
			return nil
		}
		err := event(name, strings.Join(data, "\n"))
		data = nil
		name = "message"
		return err
	}
	process := func() error {
		s := line.String()
		line.Reset()
		if s == "" {
			return dispatch()
		}
		if strings.HasPrefix(s, ":") {
			return nil
		}
		key, value, found := strings.Cut(s, ":")
		if !found {
			value = ""
		}
		value = strings.TrimPrefix(value, " ")
		switch key {
		case "event":
			name = value
		case "data":
			data = append(data, value)
		}
		return nil
	}
	for {
		ch, err := b.ReadByte()
		if err != nil {
			if err != io.EOF {
				return err
			}
			return nil
		}
		total++
		if total > limit {
			return fmt.Errorf("upstream response exceeds limit")
		}
		switch ch {
		case '\r':
			if err := process(); err != nil {
				return err
			}
			next, err := b.Peek(1)
			if err == nil && next[0] == '\n' {
				_, _ = b.ReadByte()
				total++
				if total > limit {
					return fmt.Errorf("upstream response exceeds limit")
				}
			}
		case '\n':
			if err := process(); err != nil {
				return err
			}
		default:
			line.WriteByte(ch)
		}
	}
}
