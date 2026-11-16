### baseline (model default = claude-fable-5-2, server tree plasticity-mcp-pick)

| part | runs | wall s (median) | turns | tool calls | errors / retries | output tok | input fresh / cached | cost $ | verified |
|---|---|---|---|---|---|---|---|---|---|
| a | 2 | 54.3 (60/48) | 3.5 | 4.5 | 0 / 0 | 4407 | 7 / 99520 | 0.408 | 1/2 |
| b | 2 | 54.9 (49/61) | 7 | 7.5 | 0.5 / 0.5 | 4076.5 | 14 / 228085 | 0.511 | 2/2 |
| c | 2 | 27.4 (24/30) | 3.5 | 2.5 | 0 / 0 | 1800 | 7 / 77030 | 0.182 | 2/2 |
| d | 2 | 61.6 (67/56) | 8.5 | 10.5 | 0 / 0 | 4446.5 | 17 / 301909 | 0.601 | 2/2 |
| e | 2 | 52.6 (55/51) | 5 | 5 | 0 / 0 | 4048 | 10 / 133605 | 0.353 | 2/2 |

Measured per-turn model latency: mean 8.1 s over 55 turns (median per-run mean 7.9 s). Output rate: 84 tok/s (all output tokens incl. thinking / total turn latency). Implied by regression: 1.5 s fixed per turn + 103 tok/s output (fit over 10 runs, thinking included in output tokens). Thinking tokens: 17698 of 37556 output tokens. Tool execution (server + client): median 0.16 s per call. Startup (spawn to init): median 0.7 s.
Audit cost model (mid): 3 s per turn, 70 tok/s output, reasoning x1.0 of output. Per-turn latency here is the whole turn (time to first token + output + reasoning), so compare it to 3 s + output_tokens x 2 / 70.
