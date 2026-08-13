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

	for _, event := range parseSSE(response.Body) {
		if event.ID != "" {
			s.lastEventID = event.ID
			if s.seen[event.ID] {
				continue // dedup a replayed event
			}
			s.seen[event.ID] = true
		}
		stop, handleErr := handle(event)
		if handleErr != nil {
			return true, handleErr
		}
		if stop {
			return true, nil
		}
	}
	return false, io.ErrUnexpectedEOF // stream cut short: allow reconnect
}

// parseSSE decodes a text/event-stream body into complete events. It is a
// minimal parser sufficient for id/event/data fields separated by blank lines.
func parseSSE(body io.Reader) []Event {
	var events []Event
	scanner := bufio.NewScanner(body)
	scanner.Buffer(make([]byte, 0, 64*1024), 16*1024*1024)
	var current Event
	var data strings.Builder
	flush := func() {
		if current.ID == "" && current.Type == "" && data.Len() == 0 {
			return
		}
		current.Data = data.String()
		events = append(events, current)
		current = Event{}
		data.Reset()
	}
	for scanner.Scan() {
		line := scanner.Text()
		if line == "" {
			flush()
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
	flush()
	return events
}
