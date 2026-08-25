# Proxy-aware Agent reuse benchmark

Date: 2026-08-26 (Asia/Shanghai)

## Scope and environment

- Node.js: `v24.19.0`
- PowerShell: `7.6.4`
- Platform: `win32-x64`
- Workload: 100 sequential requests per mode, three internal rounds per invocation, three independent invocations (nine measured rounds per mode)
- Network: local `127.0.0.1` origin and proxy only; no ChatGPT, SAP, DNS, or external host access
- Hard failures: route isolation, request count, origin connection count, and proxy connection count mismatches

Connection columns are `origin/proxy`. Every row completed 100 origin requests. Direct and `NO_PROXY` rows completed zero proxy requests; explicit proxy rows completed 100 proxy requests.

## Raw results — invocation 1

| Round | Mode | Connections | Median ms | p95 ms | Total ms | Cancel ms | Shutdown ms |
|---:|---|---:|---:|---:|---:|---:|---:|
| 1 | current direct/per-request | 100/0 | 1.027 | 2.270 | 150.332 | 21.609 | 0.000 |
| 1 | candidate direct/shared | 1/0 | 0.314 | 0.906 | 43.644 | 12.092 | 0.009 |
| 1 | current proxy/per-request | 100/100 | 1.833 | 3.314 | 218.529 | 25.914 | 0.000 |
| 1 | candidate proxy/shared | 100/1 | 1.261 | 2.242 | 145.380 | 24.118 | 0.009 |
| 1 | candidate NO_PROXY bypass | 1/0 | 0.198 | 0.311 | 24.184 | 21.561 | 0.008 |
| 2 | current direct/per-request | 100/0 | 0.739 | 1.331 | 92.594 | 24.532 | 0.000 |
| 2 | candidate direct/shared | 1/0 | 0.163 | 0.269 | 21.745 | 12.235 | 0.005 |
| 2 | current proxy/per-request | 100/100 | 1.350 | 2.104 | 160.944 | 23.909 | 0.000 |
| 2 | candidate proxy/shared | 100/1 | 0.862 | 1.283 | 95.701 | 13.529 | 0.009 |
| 2 | candidate NO_PROXY bypass | 1/0 | 0.146 | 0.261 | 19.802 | 19.411 | 0.005 |
| 3 | current direct/per-request | 100/0 | 0.571 | 0.925 | 70.111 | 12.438 | 0.000 |
| 3 | candidate direct/shared | 1/0 | 0.147 | 0.250 | 19.160 | 14.495 | 0.007 |
| 3 | current proxy/per-request | 100/100 | 1.245 | 2.067 | 147.583 | 16.933 | 0.000 |
| 3 | candidate proxy/shared | 100/1 | 0.850 | 1.367 | 97.117 | 21.989 | 0.012 |
| 3 | candidate NO_PROXY bypass | 1/0 | 0.107 | 0.160 | 14.978 | 15.350 | 0.009 |

## Raw results — invocation 2

| Round | Mode | Connections | Median ms | p95 ms | Total ms | Cancel ms | Shutdown ms |
|---:|---|---:|---:|---:|---:|---:|---:|
| 1 | current direct/per-request | 100/0 | 1.037 | 2.092 | 140.147 | 16.840 | 0.001 |
| 1 | candidate direct/shared | 1/0 | 0.293 | 0.647 | 39.449 | 12.636 | 0.014 |
| 1 | current proxy/per-request | 100/100 | 1.921 | 3.241 | 226.686 | 24.354 | 0.000 |
| 1 | candidate proxy/shared | 100/1 | 1.174 | 2.042 | 136.056 | 19.703 | 0.007 |
| 1 | candidate NO_PROXY bypass | 1/0 | 0.192 | 0.350 | 24.928 | 14.228 | 0.006 |
| 2 | current direct/per-request | 100/0 | 0.718 | 1.319 | 90.596 | 25.398 | 0.000 |
| 2 | candidate direct/shared | 1/0 | 0.150 | 0.221 | 20.211 | 13.665 | 0.006 |
| 2 | current proxy/per-request | 100/100 | 1.276 | 1.999 | 148.659 | 17.158 | 0.000 |
| 2 | candidate proxy/shared | 100/1 | 0.905 | 1.585 | 99.984 | 18.025 | 0.013 |
| 2 | candidate NO_PROXY bypass | 1/0 | 0.137 | 0.239 | 21.148 | 11.326 | 0.007 |
| 3 | current direct/per-request | 100/0 | 0.548 | 0.804 | 64.810 | 18.720 | 0.000 |
| 3 | candidate direct/shared | 1/0 | 0.134 | 0.237 | 18.684 | 10.634 | 0.004 |
| 3 | current proxy/per-request | 100/100 | 1.187 | 1.987 | 140.467 | 12.868 | 0.000 |
| 3 | candidate proxy/shared | 100/1 | 0.821 | 1.422 | 93.991 | 25.021 | 0.006 |
| 3 | candidate NO_PROXY bypass | 1/0 | 0.118 | 0.220 | 16.852 | 13.650 | 0.005 |

## Raw results — invocation 3

| Round | Mode | Connections | Median ms | p95 ms | Total ms | Cancel ms | Shutdown ms |
|---:|---|---:|---:|---:|---:|---:|---:|
| 1 | current direct/per-request | 100/0 | 1.300 | 2.447 | 175.476 | 16.026 | 0.000 |
| 1 | candidate direct/shared | 1/0 | 0.335 | 0.735 | 44.182 | 18.757 | 0.010 |
| 1 | current proxy/per-request | 100/100 | 2.409 | 4.099 | 278.867 | 22.871 | 0.000 |
| 1 | candidate proxy/shared | 100/1 | 1.224 | 2.549 | 144.947 | 18.349 | 0.007 |
| 1 | candidate NO_PROXY bypass | 1/0 | 0.209 | 0.294 | 25.169 | 17.976 | 0.006 |
| 2 | current direct/per-request | 100/0 | 0.678 | 1.263 | 84.612 | 22.134 | 0.000 |
| 2 | candidate direct/shared | 1/0 | 0.161 | 0.235 | 19.572 | 19.583 | 0.007 |
| 2 | current proxy/per-request | 100/100 | 1.226 | 2.072 | 142.939 | 20.066 | 0.000 |
| 2 | candidate proxy/shared | 100/1 | 0.792 | 1.088 | 88.662 | 11.587 | 0.008 |
| 2 | candidate NO_PROXY bypass | 1/0 | 0.140 | 0.236 | 19.007 | 14.041 | 0.006 |
| 3 | current direct/per-request | 100/0 | 0.506 | 0.662 | 60.375 | 22.605 | 0.000 |
| 3 | candidate direct/shared | 1/0 | 0.112 | 0.153 | 16.547 | 17.658 | 0.009 |
| 3 | current proxy/per-request | 100/100 | 1.185 | 1.847 | 140.779 | 23.250 | 0.000 |
| 3 | candidate proxy/shared | 100/1 | 0.780 | 1.315 | 87.822 | 13.738 | 0.005 |
| 3 | candidate NO_PROXY bypass | 1/0 | 0.128 | 0.361 | 19.246 | 13.661 | 0.004 |

## Nine-round medians

| Mode | Connections | Median ms | p95 ms | Total ms | Cancel ms | Shutdown ms |
|---|---:|---:|---:|---:|---:|---:|
| current direct/per-request | 100/0 | 0.718 | 1.319 | 90.596 | 21.609 | 0.000 |
| candidate direct/shared | 1/0 | 0.161 | 0.250 | 20.211 | 13.665 | 0.007 |
| current proxy/per-request | 100/100 | 1.276 | 2.072 | 148.659 | 22.871 | 0.000 |
| candidate proxy/shared | 100/1 | 0.862 | 1.422 | 97.117 | 18.349 | 0.008 |
| candidate NO_PROXY bypass | 1/0 | 0.140 | 0.261 | 19.802 | 14.228 | 0.006 |

## Gate result

**Hard gate 2: SATISFIED for a bounded production follow-up, pending explicit approval of the expanded file list.**

- Direct Agent reuse reduced origin connections from 100 to 1 in all nine rounds and reduced the median request latency from 0.718 ms to 0.161 ms (77.6%).
- Proxy Agent reuse reduced proxy connections from 100 to 1 in all nine rounds and reduced median request latency from 1.276 ms to 0.862 ms (32.4%). The benchmark proxy deliberately uses `agent: false` upstream, so origin connections remain 100 in both proxy modes; this does not weaken the client-to-proxy reuse result.
- Explicit proxy routing was isolated in every round: exactly 100 proxy requests for proxy modes and zero for direct modes.
- `NO_PROXY=127.0.0.1` bypassed the explicit benchmark proxy in every round: zero proxy requests and one reused direct origin connection.
- Candidate cancellation medians improved in both comparable modes. Individual measurements had local scheduler noise, but candidate maxima (19.583 ms direct, 25.021 ms proxy) did not exceed current maxima (25.398 ms direct, 25.914 ms proxy).
- Candidate Agent shutdown remained between 0.004 ms and 0.014 ms and introduced no observable shutdown regression.

No production networking code was changed by this benchmark. The candidate implementation must retain proxy isolation and `NO_PROXY`, and must expose deterministic Agent disposal through the existing extension shutdown owner.
