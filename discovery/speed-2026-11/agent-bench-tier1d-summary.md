### tier1d (model default = claude-fable-5-2, server tree plasticity-mcp-merge)

| part | runs | wall s (median) | turns | tool calls | errors / retries | output tok | input fresh / cached | cost $ | verified |
|---|---|---|---|---|---|---|---|---|---|
| a | 3 | 33.7 (34/39/33) | 3 | 3 | 0 / 0 | 2432 | 6 / 84090 | 0.214 | 3/3 |
| b | 3 | 29.4 (29/26/31) | 3 | 2 | 0 / 0 | 2182 | 6 / 81597 | 0.170 | 3/3 |
| c | 3 | 20.1 (20/19/22) | 3 | 2 | 0 / 0 | 1147 | 6 / 79790 | 0.129 | 3/3 |
| d | 3 | 38.9 (34/42/39) | 5 | 5 | 0 / 0 | 2506 | 10 / 165357 | 0.310 | 3/3 |
| e | 3 | 29.4 (33/27/29) | 3 | 2 | 0 / 0 | 2058 | 6 / 82740 | 0.174 | 3/3 |

Measured per-turn model latency: mean 7.5 s over 52 turns (median per-run mean 7.6 s). Output rate: 79 tok/s (all output tokens incl. thinking / total turn latency). Implied by regression: 1.8 s fixed per turn + 104 tok/s output (fit over 15 runs, thinking included in output tokens). Thinking tokens: 16329 of 30998 output tokens. Tool execution (server + client): median 0.48 s per call. Startup (spawn to init): median 0.7 s.
Audit cost model (mid): 3 s per turn, 70 tok/s output, reasoning x1.0 of output. Per-turn latency here is the whole turn (time to first token + output + reasoning), so compare it to 3 s + output_tokens x 2 / 70.
