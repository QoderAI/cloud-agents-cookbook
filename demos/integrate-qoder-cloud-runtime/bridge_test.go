// SPDX-License-Identifier: Apache-2.0

package bridge

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestBatchRunsOnceThenReplaysWithoutReexecution(t *testing.T) {
	store := &fakeStore{}
	runner := NewBatchRunner(store, TaskScope{Kind: TaskIssue, AssignedIssueID: assignedID})

	// Two buffered custom_tool_use events form one declared batch.
	runner.Buffer(ToolRequest{EventID: "ev-1", Tool: "multica_update_issue", RawInput: []byte(`{"issue_id":"` + assignedID + `","status":"in_progress"}`)})
	runner.Buffer(ToolRequest{EventID: "ev-2", Tool: "multica_add_issue_comment", RawInput: []byte(`{"issue_id":"` + assignedID + `","content":"working on it"}`)})

	batch := []string{"ev-1", "ev-2"}
	first, err := runner.RunBatch(batch)
	if err != nil {
		t.Fatalf("first run: %v", err)
	}
	if len(first) != 2 || first[0].IsError || first[1].IsError {
		t.Fatalf("unexpected first results: %+v", first)
	}
	if store.updates != 1 || store.comments != 1 {
		t.Fatalf("expected one update + one comment, got updates=%d comments=%d", store.updates, store.comments)
	}

	// Replay the same batch (as after an SSE reconnect or ambiguous POST).
	replay, err := runner.RunBatch(batch)
	if err != nil {
		t.Fatalf("replay: %v", err)
	}
	if len(replay) != 2 {
		t.Fatalf("replay result count: %d", len(replay))
	}
	// The mutating tools must NOT have run again.
	if store.updates != 1 || store.comments != 1 {
		t.Fatalf("replay re-executed mutations: updates=%d comments=%d", store.updates, store.comments)
	}
	if runner.ExecutedCount() != 2 {
		t.Fatalf("expected 2 distinct executions, got %d", runner.ExecutedCount())
	}
}

func TestBatchFailsClosed(t *testing.T) {
	runner := NewBatchRunner(&fakeStore{}, TaskScope{Kind: TaskChat})
	runner.Buffer(ToolRequest{EventID: "ev-1", Tool: "multica_list_issues", RawInput: []byte(`{}`)})

	if _, err := runner.RunBatch(nil); err == nil {
		t.Fatal("empty batch must fail closed")
	}
	if _, err := runner.RunBatch([]string{"ev-unknown"}); err == nil {
		t.Fatal("unknown required action must fail closed")
	}
	// ev-1 was buffered but never executed: a terminal idle must fail closed.
	if err := runner.FinalizeIdle(); err == nil {
		t.Fatal("unresolved custom tool at idle must fail closed")
	}
}

func TestBatchPartialFailureReturnsErrorResultWithoutAborting(t *testing.T) {
	store := &fakeStore{}
	runner := NewBatchRunner(store, TaskScope{Kind: TaskIssue, AssignedIssueID: assignedID})
	// First tool is valid; second targets another issue and must fail in scope.
	runner.Buffer(ToolRequest{EventID: "ok", Tool: "multica_update_issue", RawInput: []byte(`{"issue_id":"` + assignedID + `","priority":"high"}`)})
	runner.Buffer(ToolRequest{EventID: "bad", Tool: "multica_get_issue", RawInput: []byte(`{"issue_id":"33333333-3333-4333-8333-333333333333"}`)})

	results, err := runner.RunBatch([]string{"ok", "bad"})
	if err != nil {
		t.Fatalf("batch should return per-tool results, not abort: %v", err)
	}
	if results[0].IsError {
		t.Fatalf("first tool should succeed: %+v", results[0])
	}
	if !results[1].IsError {
		t.Fatal("out-of-scope tool should yield an error result")
	}
	if store.updates != 1 {
		t.Fatalf("valid tool should have run once, got %d", store.updates)
	}
}

// TestStreamResumesWithLastEventIDAndDeduplicates drops the connection after
// the first event, then serves a reconnect that replays the last event before
// continuing. The reader must resume via Last-Event-ID, dedup the replay, and
// deliver every distinct event exactly once, in order.
func TestStreamResumesWithLastEventIDAndDeduplicates(t *testing.T) {
	var hits int
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits++
		flusher, _ := w.(http.Flusher)
		w.Header().Set("Content-Type", "text/event-stream")
		if hits == 1 {
			// Deliver ev-1, then cut the stream short (no blank-line close on purpose).
			fmt.Fprint(w, "id: ev-1\nevent: agent.message\ndata: first\n\n")
			if flusher != nil {
				flusher.Flush()
			}
			return // connection ends abruptly -> reader reconnects
		}
		// Reconnect must carry the last event ID we saw.
		if got := r.Header.Get("Last-Event-ID"); got != "ev-1" {
			t.Errorf("reconnect Last-Event-ID = %q, want ev-1", got)
		}
		// Server replays ev-1 (duplicate) then sends ev-2 and a terminal idle.
		fmt.Fprint(w, "id: ev-1\nevent: agent.message\ndata: first\n\n")
		fmt.Fprint(w, "id: ev-2\nevent: agent.message\ndata: second\n\n")
		fmt.Fprint(w, "id: ev-3\nevent: session.status_idle\ndata: idle\n\n")
	}))
	defer server.Close()

	reader := NewStreamReader(server.Client(), server.URL, "placeholder-token")
	var delivered []string
	err := reader.Read(context.Background(), func(e Event) (bool, error) {
		delivered = append(delivered, e.ID)
		return e.Type == "session.status_idle", nil
	})
	if err != nil {
		t.Fatalf("stream read: %v", err)
	}
	want := []string{"ev-1", "ev-2", "ev-3"}
	if len(delivered) != len(want) {
		t.Fatalf("delivered %v, want %v", delivered, want)
	}
	for i := range want {
		if delivered[i] != want[i] {
			t.Fatalf("event %d = %q, want %q (delivered=%v)", i, delivered[i], want[i], delivered)
		}
	}
}
