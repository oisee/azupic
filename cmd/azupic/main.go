package main

import (
	"context"
	"flag"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"azupic/internal/bridge"
)

var Version = "0.1.0"

func main() {
	version := flag.Bool("version", false, "print version")
	flag.Parse()
	if *version {
		fmt.Println("azupic " + Version)
		return
	}
	c, err := bridge.LoadConfig()
	if err != nil {
		slog.Error("configuration error", "reason", err.Error())
		os.Exit(1)
	}
	h := bridge.NewServer(c)
	srv := &http.Server{Addr: c.Listen, Handler: h, ReadHeaderTimeout: 10 * time.Second, ReadTimeout: 30 * time.Second, IdleTimeout: time.Minute, MaxHeaderBytes: 1 << 20}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	go func() {
		<-ctx.Done()
		shutdown, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := srv.Shutdown(shutdown); err != nil {
			_ = srv.Close()
		}
	}()
	slog.Info("azupic listening", "address", c.Listen, "url", c.SafeURL(), "deployment", c.Deployment, "protocol", "responses")
	if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		slog.Error("server failed", "reason", err.Error())
		os.Exit(1)
	}
}
