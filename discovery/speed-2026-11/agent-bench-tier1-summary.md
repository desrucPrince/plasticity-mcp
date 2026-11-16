### tier1 (model default = claude-fable-5-2, server tree plasticity-mcp-merge)

| part | runs | wall s (median) | turns | tool calls | errors / retries | output tok | input fresh / cached | cost $ | verified |
|---|---|---|---|---|---|---|---|---|---|
| a | 2 | 33.6 (36/31) | 2.5 | 1.5 | 0 / 0 | 2511 | 5 / 67148 | 0.180 | 2/2 |
| b | 2 | 39.6 (38/41) | 4.5 | 3.5 | 0 / 0 | 2849 | 9 / 125885 | 0.235 | 2/2 |
| c | 2 | 22.6 (23/23) | 3 | 2 | 0 / 0 | 1471.5 | 6 / 77290 | 0.139 | 2/2 |
| d | 2 | 43.4 (44/43) | 6.5 | 6 | 0 / 0 | 2718.5 | 13 / 188956 | 0.298 | 2/2 |
| e | 2 | 41.9 (50/34) | 3.5 | 2.5 | 0 / 0 | 3185.5 | 7 / 96501 | 0.226 | 2/2 |

Measured per-turn model latency: mean 7.9 s over 40 turns (median per-run mean 7.9 s). Output rate: 81 tok/s (all output tokens incl. thinking / total turn latency). Implied by regression: 1.7 s fixed per turn + 102 tok/s output (fit over 10 runs, thinking included in output tokens). Thinking tokens: 12800 of 25471 output tokens. Tool execution (server + client): median 0.38 s per call. Startup (spawn to init): median 0.7 s.
Audit cost model (mid): 3 s per turn, 70 tok/s output, reasoning x1.0 of output. Per-turn latency here is the whole turn (time to first token + output + reasoning), so compare it to 3 s + output_tokens x 2 / 70.
