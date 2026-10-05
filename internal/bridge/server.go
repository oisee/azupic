package bridge

import (
	"bytes"
	"context"
	"crypto/subtle"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"mime"
	"net/http"
	"strings"
	"sync"
	"time"
)

type Server struct {
	Config Config
	Client *http.Client
	Log    *slog.Logger
}

func NewServer(c Config) *Server {
	t := http.DefaultTransport.(*http.Transport).Clone()
	t.ResponseHeaderTimeout = 2 * time.Minute
	return &Server{Config: c, Client: &http.Client{Transport: t, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}, Log: slog.Default()}
}
func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("request-id", newID("req_"))
	if r.URL.Path == "/healthz" && r.Method == "GET" {
		writeJSON(w, 200, object{"status": "ok", "name": "azupic"})
		return
	}
	if s.Config.Token != "" {
		token := r.Header.Get("x-api-key")
		if token == "" {
			token = strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
		}
		if subtle.ConstantTimeCompare([]byte(token), []byte(s.Config.Token)) != 1 {
			writeError(w, 401, "authentication_error", "invalid bridge token")
			return
		}
	}
	if r.Method != "POST" || (r.URL.Path != "/v1/messages" && r.URL.Path != "/v1/messages/count_tokens") {
		writeError(w, 404, "not_found_error", "endpoint not found")
		return
	}
	mt, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if err != nil || mt != "application/json" {
		writeError(w, 415, "invalid_request_error", "Content-Type must be application/json")
		return
	}
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, s.Config.BodyLimit))
	if err != nil {
		writeError(w, 413, "invalid_request_error", "request body too large or unreadable")
		return
	}
	m, err := decodeObject(body)
	if err != nil {
		writeError(w, 400, "invalid_request_error", err.Error())
		return
	}
	if r.URL.Path == "/v1/messages/count_tokens" {
		// Count the transformed request, including encrypted reasoning and tool schemas.
		copy := object{}
		for k, v := range m {
			copy[k] = v
		}
		copy["max_tokens"] = json.Number("1")
		req, err := Translate(copy, s.Config)
		if err != nil {
			writeError(w, 400, "invalid_request_error", err.Error())
			return
		}
		b, _ := json.Marshal(req.Body)
		w.Header().Set("x-azupic-token-count", "estimate")
		writeJSON(w, 200, object{"input_tokens": len(b)/3 + len(arr(req.Body["input"]))*16 + 128})
		return
	}
	req, err := Translate(m, s.Config)
	if err != nil {
		s.Log.Warn("request rejected", "status", 400, "reason", err.Error())
		writeError(w, 400, "invalid_request_error", err.Error())
		return
	}
	if cm := obj(m["context_management"]); len(arr(cm["edits"])) > 0 {
		s.Log.Info("context clearing not applied; retaining full history", "deployment", req.Model)
	}
	effort := str(obj(req.Body["reasoning"]), "effort")
	if effort == "" {
		effort = "provider-default"
	}
	s.Log.Info("generation request", "deployment", req.Model, "reasoning_effort", effort)
	ctx, cancel := context.WithTimeout(r.Context(), s.Config.Timeout)
	defer cancel()
	data, _ := json.Marshal(req.Body)
	up, err := http.NewRequestWithContext(ctx, "POST", s.Config.URL, bytes.NewReader(data))
	if err != nil {
		writeError(w, 500, "api_error", "cannot construct upstream request")
		return
	}
	up.Header.Set("Content-Type", "application/json")
	up.Header.Set("Accept", "text/event-stream")
	if s.Config.Auth == "api-key" {
		up.Header.Set("api-key", s.Config.Key)
	} else {
		up.Header.Set("Authorization", "Bearer "+s.Config.Key)
	}
	started := time.Now()
	res, err := s.Client.Do(up)
	if err != nil {
		s.Log.Warn("upstream transport failed", "url", s.Config.SafeURL(), "deployment", req.Model, "protocol", "responses")
		writeError(w, 502, "api_error", "Azure transport failed or timed out")
		return
	}
	defer res.Body.Close()
	s.Log.Info("upstream response", "url", s.Config.SafeURL(), "deployment", req.Model, "protocol", "responses", "status", res.StatusCode, "apim_request_id", res.Header.Get("apim-request-id"), "headers_ms", time.Since(started).Milliseconds())
	if v := res.Header.Get("apim-request-id"); v != "" {
		w.Header().Set("x-azupic-upstream-request-id", v)
	}
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		if v := res.Header.Get("Retry-After"); v != "" {
			w.Header().Set("Retry-After", v)
		}
		code := res.StatusCode
		if code < 400 {
			code = 502
		}
		kind := "api_error"
		if code == 429 {
			kind = "rate_limit_error"
		}
		writeError(w, code, kind, fmt.Sprintf("Azure Responses returned HTTP %d; inspect endpoint and deployment", res.StatusCode))
		return
	}
	media, _, _ := mime.ParseMediaType(res.Header.Get("Content-Type"))
	if media != "text/event-stream" {
		writeError(w, 502, "api_error", "Azure did not return a Responses SSE stream")
		return
	}
	var emit emitFunc = func(object) error { return nil }
	if req.Stream {
		w.Header().Set("Content-Type", "text/event-stream")
		w.Header().Set("Cache-Control", "no-cache")
		w.Header().Set("X-Accel-Buffering", "no")
		w.WriteHeader(200)
		emit = func(e object) error {
			rc := http.NewResponseController(w)
			_ = rc.SetWriteDeadline(time.Now().Add(s.Config.IdleTimeout))
			if _, err := w.Write(sseBytes(e)); err != nil {
				return err
			}
			return rc.Flush()
		}
	}
	o := NewOutput(req.Model, s.Config.scope(req.Model), emit, arr(req.Body["tools"]))
	if err = o.Start(); err != nil {
		return
	}
	reader := newIdleReader(res.Body, s.Config.IdleTimeout, cancel)
	defer reader.Close()
	err = ReadSSE(reader, s.Config.ResponseLimit, func(name, data string) error {
		if err := o.Event(name, data); err != nil {
			return err
		}
		if o.terminal {
			return errTerminal
		}
		return nil
	})
	if err == errTerminal {
		err = nil
	}
	if err == nil && !o.terminal {
		err = fmt.Errorf("upstream ended before terminal response")
	}
	if err != nil {
		cancel()
		s.Log.Warn("generation failed", "reason", err.Error(), "deployment", req.Model)
		if req.Stream {
			_ = emit(object{"type": "error", "error": object{"type": "api_error", "message": err.Error()}})
		} else {
			writeError(w, 502, "api_error", err.Error())
		}
		return
	}
	if !req.Stream {
		writeJSON(w, 200, o.JSON())
	}
}

var errTerminal = fmt.Errorf("terminal response received")

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}
func writeError(w http.ResponseWriter, status int, kind, message string) {
	writeJSON(w, status, object{"type": "error", "error": object{"type": kind, "message": message}})
}

type idleReader struct {
	io.ReadCloser
	mu       sync.Mutex
	timer    *time.Timer
	duration time.Duration
	cancel   context.CancelFunc
	closed   bool
}

func newIdleReader(r io.ReadCloser, d time.Duration, cancel context.CancelFunc) *idleReader {
	v := &idleReader{ReadCloser: r, duration: d, cancel: cancel}
	v.timer = time.AfterFunc(d, func() {
		v.mu.Lock()
		defer v.mu.Unlock()
		if !v.closed {
			v.closed = true
			cancel()
			_ = r.Close()
		}
	})
	return v
}
func (r *idleReader) Read(p []byte) (int, error) {
	n, err := r.ReadCloser.Read(p)
	r.mu.Lock()
	if !r.closed && n > 0 {
		r.timer.Reset(r.duration)
	}
	r.mu.Unlock()
	return n, err
}
func (r *idleReader) Close() error {
	r.mu.Lock()
	r.closed = true
	r.timer.Stop()
	r.mu.Unlock()
	return r.ReadCloser.Close()
}
