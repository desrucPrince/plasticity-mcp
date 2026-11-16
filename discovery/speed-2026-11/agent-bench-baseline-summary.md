### baseline (model default = claude-fable-5-2, server tree plasticity-mcp-pick)

| part | runs | wall s (median) | turns | tool calls | errors / retries | output tok | input fresh / cached | cost $ | verified |
|---|---|---|---|---|---|---|---|---|---|
| a | 2 | 62.4 (63/62) | 5 | 5 | 0.5 / 0.5 | 5001.5 | 10 / 142349 | 0.393 | 2/2 |
| b | 2 | 47.6 (49/46) | 5.5 | 6 | 0 / 0 | 3599 | 11 / 134819 | 0.325 | 2/2 |
| c | 2 | 23.6 (23/25) | 3 | 3 | 0 / 0 | 1539.5 | 6 / 80134 | 0.326 | 2/2 |
| d | 2 | 63.5 (50/77) | 9 | 10.5 | 0 / 0 | 4380.5 | 18 / 348410 | 0.707 | 2/2 |
| e | 2 | 56.1 (58/54) | 5.5 | 5.5 | 0 / 0 | 4343.5 | 11 / 161877 | 0.498 | 2/2 |

Measured per-turn model latency: mean 8.1 s over 56 turns (median per-run mean 7.8 s). Output rate: 84 tok/s (all output tokens incl. thinking / total turn latency). Implied by regression: 1.5 s fixed per turn + 103 tok/s output (fit over 10 runs, thinking included in output tokens). Thinking tokens: 18414 of 37728 output tokens. Tool execution (server + client): median 0.17 s per call. Startup (spawn to init): median 0.7 s.
Audit cost model (mid): 3 s per turn, 70 tok/s output, reasoning x1.0 of output. Per-turn latency here is the whole turn (time to first token + output + reasoning), so compare it to 3 s + output_tokens x 2 / 70.
