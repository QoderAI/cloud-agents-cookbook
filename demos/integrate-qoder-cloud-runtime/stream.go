// SPDX-License-Identifier: Apache-2.0

package bridge

import (
	"bufio"
	"context"
	"fmt"
	"io"
	"net/http"
	"strings"
)

// Event is a decoded SSE frame from the session event stream.
type Event struct {
	ID   string
	Type string
	Data string
}

// StreamReader consumes a session's SSE event stream. On a dropped connection
// it reconnects with Last-Event-ID set to the newest event it already saw, and
// it deduplicates any events the server replays, so no event is processed twice
// and none is lost across a reconnect.
type StreamReader struct {
	client       *http.Client
	url          string
	pat          string
	lastEventID  string
	seen         map[string]bool
	maxReconnect int
}

// NewStreamReader builds a reader for one session stream URL.
func NewStreamReader(client *http.Client, url, pat string) *StreamReader {
	return &StreamReader{
		client:       client,
		url:          url,
		pat:          pat,
		seen:         map[string]bool{},
		maxReconnect: 5,
	}
}

// Read streams events to handle until the stream ends or the context is done.
// A transient connection drop triggers a bounded reconnect using Last-Event-ID.
// handle returning true stops the stream (for example on a terminal idle).
func (s *StreamReader) Read(ctx context.Context, handle func(Event) (stop bool, err error)) error {
	attempts := 0
	for {
		done, err := s.readOnce(ctx, handle)
		if done {
			return err
		}
		if err == nil {
			return nil // clean stream end
		}
		attempts++
		if attempts > s.maxReconnect {
			return fmt.Errorf("stream failed after %d reconnects: %w", s.maxReconnect, err)
		}
		// Reconnect; Last-Event-ID makes the server resume after the last
		// event we saw, and seen{} discards any it replays anyway.
	}
}

func (s *StreamReader) readOnce(ctx context.Context, handle func(Event) (bool, error)) (bool, error) {
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, s.url, nil)
	if err != nil {
		return true, err
	}
	request.Header.Set("Authorization", "Bearer "+s.pat)
	request.Header.Set("Accept", "text/event-stream")
	if s.lastEventID != "" {
		request.Header.Set("Last-Event-ID", s.lastEventID)
	}
	response, err := s.client.Do(request)
	if err != nil {
		return false, err // transient: allow reconnect
	}
	defer response.Body.Close()
	if response.StatusCode >= 500 || response.StatusCode == http.StatusTooManyRequests {
		return false, fmt.Errorf("stream HTTP %d", response.StatusCode)
	}
	if response.StatusCode != http.StatusOK {
		return true, fmt.Errorf("stream HTTP %d", response.StatusCode)
	}

	// Parse the event stream incrementally: dispatch each event to handle as
	// soon as its terminating blank line arrives, so a long-lived stream is
	// processed in real time and handle's stop signal takes effect promptly.
	scanner := bufio.NewScanner(response.Body)
	scanner.Buffer(make([]byte, 0, 64*1024), 16*1024*1024)
	var current Event
	var data strings.Builder

	// dispatch delivers one completed event, applying Last-Event-ID tracking
	// and replay deduplication. It reports whether the caller asked to stop.
	dispatch := func() (stop bool, err error) {
		if current.ID == "" && current.Type == "" && data.Len() == 0 {
			return false, nil
		}
		event := current
		event.Data = data.String()
		current = Event{}
		data.Reset()
		if event.ID != "" {
			s.lastEventID = event.ID
			if s.seen[event.ID] {
				return false, nil // dedup a replayed event
			}
			s.seen[event.ID] = true
		}
		return handle(event)
	}

	for scanner.Scan() {
		line := scanner.Text()
		if line == "" {
			stop, handleErr := dispatch()
			if handleErr != nil {
				return true, handleErr
			}
			if stop {
				return true, nil
			}
			continue
		}
		field, value, _ := strings.Cut(line, ":")
		value = strings.TrimPrefix(value, " ")
		switch field {
		case "id":
			current.ID = value
		case "event":
			current.Type = value
		case "data":
			if data.Len() > 0 {
				data.WriteByte('\n')
			}
			data.WriteString(value)
		}
	}
	// Flush a trailing event that ended without a final blank line.
	stop, handleErr := dispatch()
	if handleErr != nil {
		return true, handleErr
	}
	if stop {
		return true, nil
	}
	if scanErr := scanner.Err(); scanErr != nil {
		return false, scanErr // transient read failure: allow reconnect
	}
	return false, io.ErrUnexpectedEOF // stream cut short: allow reconnect
}
