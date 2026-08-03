## ADDED Requirements

### Requirement: OpenCode runtime CLI and daemon negotiate protocol compatibility

The paired CLI and daemon control tools SHALL exchange an explicit OpenCode runtime recovery protocol/schema version on every reserve and commit request.  A missing or unequal supported version SHALL return `protocol_version_mismatch` and fail closed before registry mutation, endpoint probing or prompt scheduling.

CLI SHALL use the installed paired daemon protocol rather than assuming compatibility with an independently resolved package version.  The error response SHALL include the local CLI version, daemon protocol version when available, and resolved daemon endpoint, but MUST NOT include identity key material.

#### Scenario: Matching versions allow control request

- **GIVEN** CLI and daemon support the same recovery protocol version
- **WHEN** reserve or commit is invoked
- **THEN** the request proceeds to normal validation

#### Scenario: Mismatched versions fail closed

- **GIVEN** CLI and daemon advertise different recovery protocol versions
- **WHEN** reserve or commit is invoked
- **THEN** it returns `protocol_version_mismatch`
- **AND** no registry write, endpoint probe or prompt scheduling occurs
