### baseline-sonnet (model sonnet = claude-sonnet-5-5, server tree plasticity-mcp-pick)

| part | runs | wall s (median) | turns | tool calls | errors / retries | output tok | input fresh / cached | cost $ | verified |
|---|---|---|---|---|---|---|---|---|---|
| a | 1 | 36.9 (37) | 7 | 7 | 2 / 2 | 4373 | 14 / 195008 | 0.157 | 1/1 |
| b | 1 | 45.3 (45) | 10 | 10 | 1 / 1 | 4636 | 20 / 248792 | 0.148 | 1/1 |
| c | 1 | 19.8 (20) | 6 | 5 | 0 / 0 | 1591 | 12 / 143028 | 0.096 | 1/1 |
| d | 1 | 40.3 (40) | 10 | 9 | 1 / 1 | 3442 | 20 / 282433 | 0.169 | 0/1 |
| e | 1 | 38.8 (39) | 8 | 7 | 1 / 1 | 4110 | 16 / 202251 | 0.132 | 1/1 |

Measured per-turn model latency: mean 3.8 s over 41 turns (median per-run mean 4.0 s). Output rate: 117 tok/s (all output tokens incl. thinking / total turn latency). Implied by regression: 1.5 s fixed per turn + 191 tok/s output (fit over 5 runs, thinking included in output tokens). Thinking tokens: 6109 of 18152 output tokens. Tool execution (server + client): median 0.13 s per call. Startup (spawn to init): median 0.7 s.
Audit cost model (mid): 3 s per turn, 70 tok/s output, reasoning x1.0 of output. Per-turn latency here is the whole turn (time to first token + output + reasoning), so compare it to 3 s + output_tokens x 2 / 70.

