## [1.5.0](https://github.com/yupanzi/dingorg/compare/v1.4.1...v1.5.0) (2026-10-21)

### Features

* **oidc:** 登录时向钉钉实时确认是内部员工，新人扫码时补同步 ([8f82689](https://github.com/yupanzi/dingorg/commit/8f826891c763b71a644b3fbfba3651ac7dbc987d))

## [1.4.1](https://github.com/yupanzi/dingorg/compare/v1.4.0...v1.4.1) (2026-10-20)

### Bug Fixes

* **db:** sslmode 按 libpq 语义，写 require 能连上 RDS ([735e369](https://github.com/yupanzi/dingorg/commit/735e3699a3eee6f77831f28435bc6cd48b63f4ff))

## [1.4.0](https://github.com/yupanzi/dingorg/compare/v1.3.0...v1.4.0) (2026-10-20)

### Features

* **chart:** 凭证可按键改用 valueFrom，Pod 调度与安全项、Service、Ingress 可配 ([77f596b](https://github.com/yupanzi/dingorg/commit/77f596bf4f5f2d3ea6a30f80f3fb9e18fb6baf9b))

## [1.3.0](https://github.com/yupanzi/dingorg/compare/v1.2.0...v1.3.0) (2026-10-20)

### Features

* **chart:** image.repository 默认指向发版镜像，按 OCI 地址装上即可用 ([ff8780a](https://github.com/yupanzi/dingorg/commit/ff8780a936e9895efaf6cd0f18800399d4007d0d))

## [1.2.0](https://github.com/yupanzi/dingorg/compare/v1.1.0...v1.2.0) (2026-09-30)

### Features

* **sync:** 组织快照改成同步镜像表，跨副本靠租约 ([25e49e5](https://github.com/yupanzi/dingorg/commit/25e49e543f101150a0d3575fe7ff1c25a5b263f1))

## [1.1.0](https://github.com/yupanzi/dingorg/compare/v1.0.0...v1.1.0) (2026-09-30)

### Features

* REST 改用 API key 鉴权，凭证统一收进 AUTH_JSON ([f58e363](https://github.com/yupanzi/dingorg/commit/f58e363107512b8bb6dc1ffd9a153c8a4b16f73b))
