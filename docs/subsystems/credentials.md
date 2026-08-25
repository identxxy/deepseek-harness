<a id="ctxcredentialscontroller--credentialscontroller"></a>

### `ctx.credentialsController` — `CredentialsController`

Host service backing the generated `ctx.remote.credentials` namespace. It carries every wire obligation the credential seam itself does not: the batch fan-out bound, the field-by-field view projection, the reference-grammar guard, and the refusal mapping. Secret values cross in one direction only — no method here returns one.

```ts cordis-catalog
/**
 * Describe several references for one configuration surface. Batched because
 * a settings page describes every reference its rows name at once, and one
 * round trip keeps those rows from settling separately.
 * @param refs - reference names, at most {@link MAX_DESCRIBE_REFS}; a name outside the grammar
 *   rejects the whole call as `gateway/bad-request`.
 * @returns one view per requested name, keyed by that name.
 * @throws RemoteError when the request is invalid or no credential provider is mounted.
 */
@Remote async describe(refs: string[]): Promise<Record<string, CredentialInfo>>

/**
 * Store one value from a configuration surface. The value crosses the wire in
 * this direction only: no read path returns it.
 * @param ref - reference name to store under.
 * @param value - the non-empty secret value.
 * @throws RemoteError when the request is invalid, no provider is mounted, or the provider refuses the write.
 */
@Remote async set(ref: string, value: string): Promise<void>

/**
 * Remove one reference from a configuration surface.
 * @param ref - reference name to remove.
 * @throws RemoteError when the request is invalid, no provider is mounted, or the provider refuses the write.
 */
@Remote async unset(ref: string): Promise<void>
```

Source: [`packages/api/settings-controller/src/credentials.ts`](../../packages/api/settings-controller/src/credentials.ts)
<a id="ctxdeviceauth--deviceauthservice-abstract-seam"></a>

### `ctx.deviceAuth` — `DeviceAuthService` (abstract seam)

Abstract durable device-authentication service.

```ts cordis-catalog
/**
 * Enroll a new device under an identity already verified by the caller.
 * @param principal - Verified enrollment identity.
 * @param label - Human device label.
 * @returns newly issued permanent token and browser session.
 */
abstract enroll(principal: Omit<VerifiedDevicePrincipal, 'id'>, label: string): Promise<DeviceAuthIssueResult>

/**
 * Exchange a permanent recovery credential for a fresh browser session.
 * @param deviceToken - Permanent recovery credential.
 * @returns a fresh browser session replacing any active session.
 */
abstract login(deviceToken: string): Promise<DeviceLoginResult>

/**
 * Authenticate one active browser session and optionally apply rolling renewal when due.
 * @param deviceId - Owning device id.
 * @param sessionId - Browser session id.
 * @param secret - Browser session secret.
 * @param options - Explicit carrier renewal policy.
 * @returns authentication and rolling-renewal decision.
 */
abstract authenticate( deviceId: DeviceId, sessionId: DeviceSessionId, secret: string, options: DeviceAuthenticateOptions, ): Promise<DeviceAuthentication>

/**
 * Durably remove an authenticated browser session.
 * @param deviceId - Owning device id.
 * @param sessionId - Browser session id.
 * @param secret - Browser session secret.
 * @returns after durable invalidation.
 */
abstract logout(deviceId: DeviceId, sessionId: DeviceSessionId, secret: string): Promise<void>

/**
 * List the durable device registry without credential material.
 * @returns every device as a secret-free projection.
 */
abstract listDevices(): readonly DeviceView[]

/**
 * Revoke a device credential and its active browser session.
 * @param deviceId - Device to revoke.
 * @returns after durable revocation.
 */
abstract revokeDevice(deviceId: DeviceId): Promise<void>

/**
 * Replace a device's permanent credential and remove its active browser session.
 * @param deviceId - Device whose permanent token is replaced.
 * @returns the secret-free device view and newly issued one-time-visible token.
 */
abstract rotateDeviceToken(deviceId: DeviceId): Promise<DeviceTokenRotationResult>
```

Source: [`packages/identity/device-auth/src/index.ts`](../../packages/identity/device-auth/src/index.ts)
