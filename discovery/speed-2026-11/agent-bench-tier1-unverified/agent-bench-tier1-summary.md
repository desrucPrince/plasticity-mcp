### tier1 (model default = claude-fable-5-2, server tree plasticity-mcp-merge)

| part | runs | wall s (median) | turns | tool calls | errors / retries | output tok | input fresh / cached | cost $ | verified |
|---|---|---|---|---|---|---|---|---|---|
| a | 2 | 31.3 (31/32) | 2.5 | 1.5 | 0 / 0 | 2358.5 | 5 / 66736 | 0.269 | 0/2 |
| b | 2 | 42.7 (42/43) | 5 | 4 | 0 / 0 | 3201.5 | 10 / 143456 | 0.265 | 0/2 |
| c | 2 | 21.2 (24/19) | 2.5 | 1.5 | 0 / 0 | 1349 | 5 / 64536 | 0.129 | 2/2 |
| d | 2 | 45.3 (47/43) | 7 | 6.5 | 0 / 0 | 2844 | 14 / 245856 | 0.444 | 0/2 |
| e | 2 | 29.5 (32/27) | 2 | 1 | 0 / 0 | 2298 | 4 / 53143 | 0.163 | 0/2 |

Measured per-turn model latency: mean 7.7 s over 38 turns (median per-run mean 7.6 s). Output rate: 83 tok/s (all output tokens incl. thinking / total turn latency). Implied by regression: 1.9 s fixed per turn + 109 tok/s output (fit over 10 runs, thinking included in output tokens). Thinking tokens: 11743 of 24102 output tokens. Tool execution (server + client): median 0.40 s per call. Startup (spawn to init): median 0.7 s.
Audit cost model (mid): 3 s per turn, 70 tok/s output, reasoning x1.0 of output. Per-turn latency here is the whole turn (time to first token + output + reasoning), so compare it to 3 s + output_tokens x 2 / 70.
