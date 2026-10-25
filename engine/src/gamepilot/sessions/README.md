# Device session implementation

`gamepilot.session` is the stable import facade. `DeviceSession` in `device.py`
coordinates lifecycle and delegates to small, explicitly constructed services.
No mixins, dynamic method installation, or `__getattr__` forwarding are used.

## Responsibilities

| Module | Responsibility |
| --- | --- |
| `device.py` | Shared session state, locks, thread lifecycle, status, explicit API delegates |
| `capture.py` | Capture loop, preview throttle, JPEG push, capture failure handling |
| `execution.py` | Latest-frame execution worker, runner identities, start/stop, subflows, triggers, evidence |
| `recordings.py` | Recording worker, recording ID validation, SQLite frames, paging and cleanup |
| `history.py` | Bounded preview history, exact/nearest frame lookup, JPEG encoding |
| `input.py` | Manual input, automatic input transaction guard, one-shot actions |
| `editing.py` | Session graph mutations and recording manual actions into workflow steps |
| `materials.py` | Template/color/OCR capture and common material-registration finalization |
| `yolo.py` | AI example materialization, detail/update, frozen/live AI previews |
| `graph_ops.py` | Graph-only mutations usable without a connected device |
| `models.py` | Runner value object, limits, graph-loading/error helpers |

## Dependency and state rules

- Services hold one typed `session` reference. Mutable graph, engine, runner,
  frame, and lock state has **one owner**, `DeviceSession`; services do not copy it.
- Service imports of `DeviceSession` are guarded by `TYPE_CHECKING`. Runtime
  dependencies point from `device.py` to services, never back to the facade.
- Calls across responsibilities go through explicit session methods. This keeps
  callbacks and instance-level instrumentation live: `_record_frame`, `_emit_frame`,
  `_attach_evidence` and `_collect_evidence` must not be cached or bypassed.
- Pure graph helpers are imported directly from `graph_ops.py`/`models.py`, not
  through `gamepilot.session` (which also loads the lifecycle facade).

## Concurrency invariants

- Capture, execution, and recording remain three independent workers. Execution
  and recording use one-slot latest-frame mailboxes, not unbounded queues.
- `_lifecycle_lock` is reentrant: child-workflow RPCs and automatic triggers can
  enter `start_run` while holding it. Lifecycle operations acquire it before the
  short session-state lock. Stop never waits for `_execution_lock`.
- Expensive capture, recognition, controller I/O, encoding, and evidence work
  must not gain a new enclosing session-state lock during maintenance.
- FlowEngine input uses `_input_lock` only for an input transaction; recognition
  is outside it. Manual down/up reserves the gesture and defers automation.
- Recording jobs carry the capture-time recording ID; validate it before encoding
  and again before commit. Old jobs must not enter a restarted recording.
- Runner identity, `inflight`, cancellation, and expected-instance completion
  checks prevent stopped work from finishing a new run with the same root.
- Capture snapshots keep source engine/index/time; never refresh detection age
  at inference completion or label an old result as belonging to a new frame.

## Regression checks

`tests/test_session_modules.py` checks cold imports, export identity, signatures,
explicit service delegation and module boundaries. The existing
`tests/test_session_scheduling.py` is the behavioral concurrency contract; run it
alongside recording, graph editing, material/AI, subflow and RPC tests after changes.
