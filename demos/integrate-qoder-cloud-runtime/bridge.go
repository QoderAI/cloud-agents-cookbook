// SPDX-License-Identifier: Apache-2.0

package bridge

import (
	"fmt"
	"sync"
)

// ToolRequest is one buffered custom_tool_use emitted by the cloud Agent.
// EventID is the source event ID, reused as the tool-use ID and as the
// idempotency key for exactly-once execution within this process.
type ToolRequest struct {
	EventID string
	Tool    string
	RawInput []byte
}

// ToolResult is what the bridge posts back as user.custom_tool_result.
type ToolResult struct {
	EventID string
	Output  string
	IsError bool
}

// BatchRunner buffers custom-tool requests, then executes a declared batch
// exactly once, caching results so an SSE reconnect or an ambiguous result
// POST can resend an unsent result without re-executing a mutating tool.
//
// It fails closed: an unknown declared event, an empty batch, or a terminal
// idle with unresolved custom tools all return an error before any execution.
type BatchRunner struct {
	store IssueStore
	scope TaskScope

	mu       sync.Mutex
	buffered map[string]ToolRequest // event ID -> request, filled as events arrive
	results  map[string]ToolResult  // event ID -> cached result, for replay
	executed map[string]bool        // event ID -> executed, guards exactly-once
}

// NewBatchRunner creates a runner bound to one task scope.
func NewBatchRunner(store IssueStore, scope TaskScope) *BatchRunner {
	return &BatchRunner{
		store:    store,
		scope:    scope,
		buffered: map[string]ToolRequest{},
		results:  map[string]ToolResult{},
		executed: map[string]bool{},
	}
}

// Buffer records an incoming custom_tool_use without executing it. The bridge
// emits a local tool-use message here and waits for requires_action to declare
// which buffered events form the batch.
func (r *BatchRunner) Buffer(request ToolRequest) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.buffered[request.EventID] = request
}

// RunBatch executes the declared batch once, in the given order, and returns
// the results to post back. Calling it again with the same event IDs resends
// cached results without re-executing — this is the replay path after a
// reconnect or an ambiguous POST. It fails closed on an empty or unknown batch.
func (r *BatchRunner) RunBatch(eventIDs []string) ([]ToolResult, error) {
	r.mu.Lock()
	defer r.mu.Unlock()

	if len(eventIDs) == 0 {
		return nil, fmt.Errorf("empty action batch: failing closed")
	}
	// Validate the whole declared batch before running anything.
	for _, id := range eventIDs {
		if _, ok := r.buffered[id]; !ok {
			return nil, fmt.Errorf("unknown required action %q: failing closed", id)
		}
	}

	out := make([]ToolResult, 0, len(eventIDs))
	for _, id := range eventIDs {
		if r.executed[id] {
			// Replay: resend the cached result, never re-execute.
			out = append(out, r.results[id])
			continue
		}
		request := r.buffered[id]
		output, err := Dispatch(r.store, r.scope, request.Tool, request.RawInput)
		result := ToolResult{EventID: id, Output: output}
		if err != nil {
			result.Output = err.Error()
			result.IsError = true
		}
		// Mark executed and cache the result BEFORE returning, so a later
		// replay of the same batch cannot run a mutating tool twice.
		r.executed[id] = true
		r.results[id] = result
		out = append(out, result)
	}
	return out, nil
}

// FinalizeIdle is called when the turn reaches a terminal idle. If any buffered
// tool never got executed, the run is incomplete and must fail closed rather
// than silently declaring success.
func (r *BatchRunner) FinalizeIdle() error {
	r.mu.Lock()
	defer r.mu.Unlock()
	for id := range r.buffered {
		if !r.executed[id] {
			return fmt.Errorf("terminal idle with unresolved custom tool %q: failing closed", id)
		}
	}
	return nil
}

// ExecutedCount reports how many distinct tools actually ran. Tests use it to
// prove replay did not re-execute.
func (r *BatchRunner) ExecutedCount() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return len(r.executed)
}
