### tier1e (model default = claude-fable-5-2, server tree plasticity-mcp-merge)

| part | runs | wall s (median) | turns | tool calls | errors / retries | output tok | input fresh / cached | cost $ | verified |
|---|---|---|---|---|---|---|---|---|---|
| a | 3 | 26.2 (25/26/32) | 2 | 1 | 0 / 0 | 1846 | 4 / 54963 | 0.211 | 3/3 |
| b | 3 | 31.6 (30/32/32) | 3 | 2 | 0 / 0 | 2238 | 6 / 84537 | 0.184 | 3/3 |
| c | 3 | 23.5 (19/24/24) | 3 | 2 | 0 / 0 | 1393 | 6 / 81213 | 0.143 | 3/3 |
| d | 3 | 40.4 (43/40/37) | 5 | 4 | 0 / 0 | 2598 | 10 / 163001 | 0.339 | 3/3 |
| e | 3 | 26.6 (30/25/27) | 2 | 1 | 0 / 0 | 1837 | 4 / 54989 | 0.150 | 3/3 |

Measured per-turn model latency: mean 8.3 s over 45 turns (median per-run mean 8.9 s). Output rate: 80 tok/s (all output tokens incl. thinking / total turn latency). Implied by regression: 2.1 s fixed per turn + 107 tok/s output (fit over 15 runs, thinking included in output tokens). Thinking tokens: 16099 of 29982 output tokens. Tool execution (server + client): median 0.52 s per call. Startup (spawn to init): median 0.7 s.
Audit cost model (mid): 3 s per turn, 70 tok/s output, reasoning x1.0 of output. Per-turn latency here is the whole turn (time to first token + output + reasoning), so compare it to 3 s + output_tokens x 2 / 70.
