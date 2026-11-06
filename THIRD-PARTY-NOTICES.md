# Third-party notices

Drama Warden includes or can optionally distribute the third-party components below. Their licenses apply to those components; the project MIT license does not replace them.

## Optional Quark Cloud Drive CLI

- Upstream: [quark-clouddrive/quarkclouddrive_offical](https://github.com/quark-clouddrive/quarkclouddrive_offical), pinned skill/license revision `a5830d99830c7e8bf46063ca90ac6deb1bbf1f3e`.
- CLI archive: `quarkclouddrive-1.0.25.zip`, reported CLI version `1.0.25-876f30d`.
- Download URL: `https://pdds.quark.cn/download/stfile/eekkigineefiegmgo/quarkclouddrive-1.0.25.zip`.
- Archive SHA-256: `56c34e9a9313ae29d39475b4ff9da9e92fbfd59699bf5843e3382e54434fffb8`.
- License: Apache-2.0. The upstream license text is included at [`third-party/quarkclouddrive/LICENSE`](third-party/quarkclouddrive/LICENSE) and copied into the image when the CLI is enabled.
- The CLI is excluded from the default Docker image. The pinned artifact's bundled auth tracing code configures the collector `https://px.wpk.quark.cn`; auth trace fields include token-derived values, which the current artifact transforms to six-character MD5 fingerprints before setting span attributes. Static inspection found a built-in suppression guard requiring `QK_E2E_ACTIVE=1` and `QK_E2E_WPK=0`. In this exact artifact, the guard prevents auth trace initialization and gates the tracing `setConfig`, `reportJSError`, and `flush` calls. The Drama Warden image sets both variables for the application and child CLI processes; the optional CLI Docker build asserts these guard call sites remain in the hash-verified bundle before packaging it. Running the upstream script outside this image requires setting both variables explicitly to get the same suppression. Upstream issue [#14](https://github.com/quark-clouddrive/quarkclouddrive_offical/issues/14) remains open, and the default image still excludes the CLI. The latest GitHub release is `quarkclouddrive-v1.0.25`, matching the pinned archive. This was a code inspection only; no real account or credential was used.

## Optional 115 CLI

- Package: [`115cli`](https://pypi.org/project/115cli/) version `0.3.4`, installed only when `INCLUDE_115_CLI=true` is selected at image build time.
- License: MIT, as declared in the PyPI package metadata. The license text is included at [`third-party/115cli/LICENSE`](third-party/115cli/LICENSE) and copied into the image.
- PyPI artifact SHA-256 values reviewed for this notice: wheel `ba22b11e9fb550f9d4cd607b94450e24453d82982197db2c4295376b6b15a206`; source distribution `0c4b4c564d02b157f932c5e8d24d72863dc06b1f1b1e92aa8b46bd9882fde6fe`.
- License conflict: `115cli==0.3.4` depends on [`p115cipher==0.0.4`](https://pypi.org/project/p115cipher/0.0.4/). Both PyPI metadata and `p115cipher`'s `pyproject.toml` declare MIT, but its wheel (SHA-256 `11499ac948853dbf6dafed47ba5492dbc83361f98e8b5148d7603b1b83c17243`) and source distribution (SHA-256 `4b5afcac9a7515f8b9173eeea6a2f0ddfa1125e79c64e360d4054b0aa239b83e`) contain license files declaring GNU GPL-3. As of 2026-11-05, PyPI's latest `p115cipher==0.0.6` wheel (SHA-256 `fa8cf7cf8c89281507537beec586af4a60576b6ad554cf33126d6f5dda0e1da5`) also contains GPL-3 license files, while the latest `115cli==0.3.4` still pins `p115cipher==0.0.4`. The project does not decide which declaration governs. The default image excludes 115 CLI; check the upstream package before opting in with `INCLUDE_115_CLI=true`.
- When enabled, the image installs the 16-package CPython 3.12 dependency set from [`third-party/115cli/requirements.lock`](third-party/115cli/requirements.lock) with `--require-hashes` and binary wheels only. The lock includes SHA-256 hashes for Linux x86_64 and aarch64 wheels. It prevents transitive dependency versions and downloaded artifacts from changing silently between builds.
- Current license metadata and files for the pinned Python runtime packages are:

| Package | Observed version | License metadata / file |
| --- | --- | --- |
| `anyio` | `4.16.0` | MIT |
| `blinker` | `1.9.0` | MIT |
| `bottle` | `0.13.4` | MIT |
| `certifi` | `2026.10.23` | MPL-2.0 |
| `h11` | `0.16.0` | MIT |
| `httpcore` | `1.0.9` | BSD-3-Clause |
| `httpx` | `0.28.1` | BSD-3-Clause |
| `idna` | `3.20` | BSD-3-Clause |
| `lz4` | `4.4.5` | BSD-3-Clause |
| `m3u8` | `6.0.0` | MIT |
| `p115cipher` | `0.0.4` | MIT metadata; GPL-3 license files conflict |
| `pathspec` | `1.1.1` | MPL-2.0 |
| `pycryptodome` | `4.3.0` | BSD-2-Clause, Unlicense and MIT |
| `tqdm` | `4.70.1` | MPL-2.0 and MIT |
| `typing_extensions` | `4.16.0` | PSF-2.0 |

## npm dependencies

Direct runtime, optional, and development dependencies and their locked versions:

| Package | Version | License | Use |
| --- | --- | --- | --- |
| `@drama-warden/plugin-sdk` | `0.1.0` | MIT | First-party workspace for external plugin contracts |
| `better-sqlite3` | `13.0.3` | MIT | Default SQLite driver |
| `yaml` | `2.9.1` | ISC | Validated non-secret application configuration |
| `mysql2` | `3.24.6` | MIT | Optional MySQL driver |
| `@modelcontextprotocol/sdk` | `1.32.2` | MIT | Optional MCP process |
| `zod` | `4.6.7` | MIT | MCP input schemas |
| `vue` | `3.5.44` | MIT | Frontend runtime |
| `vite` | `6.4.5` | MIT | Frontend build tool |
| `@vitejs/plugin-vue` | `5.2.4` | MIT | Vue integration for Vite |
| `typescript` | `5.0.4` | Apache-2.0 | Minimum-version compatibility check for the external plugin SDK |
| `typescript` | `7.0.2` | Apache-2.0 | Development-only type checking for the external plugin SDK |

`package-lock.json` records license metadata for all 215 packages, including the first-party plugin SDK workspace. The checked-in [`npm-license-inventory.json`](third-party/npm-license-inventory.json) records each resolved package path, version and lockfile license field; CI fails when a package is added, removed, upgraded or changes its declared license until the inventory is reviewed. Run `npm run update:license-inventory` only after checking the affected upstream packages and updating this notice as needed. The current SPDX identifiers are Apache-2.0, BSD-2-Clause, BSD-3-Clause, ISC and MIT. Lockfile metadata is a starting point for review, not a substitute for checking the distributed license files.
