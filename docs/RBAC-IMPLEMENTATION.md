# RBAC Layer Implementation Plan

## Context
Current app executes MongoDB queries directly without access control. For external users, need RBAC to ensure users only query authorized data (own data or organization data).

## Architecture

**Current flow:**
```
User → API (chat/route.ts) → Agent → ExecuteMongoDB → MongoDB
```

**Proposed flow:**
```
User → JWT Header → API → Agent (with user context) → RBAC-filtered ExecuteMongoDB → MongoDB
```

**Key insight:** Enforce RBAC at tool level (ExecuteMongoDB), not agent level. This prevents prompt injection bypasses and works regardless of how queries are constructed.

**Auth:** Custom JWT (existing auth system elsewhere)
**Access levels:** `user` (own data) + `org_admin` (all org data)

---

## Implementation

### 1. Create RBAC Types
**File:** `src/lib/rbac/types.ts`

```typescript
export type AccessLevel = 'user' | 'org_admin';

export interface UserContext {
  userId: string;
  accountId: string;      // User's account
  businessId: string;     // Organization ID
  accessLevel: AccessLevel;
}
```

### 2. Create Query Rewriter
**File:** `src/lib/rbac/query-rewriter.ts`

Core logic:
- For `find` queries: inject RBAC filter into `filter` object
- For `aggregate` queries: prepend `$match` stage with RBAC filter
- `org_admin`: filter by `businessId`
- `user`: filter by `accountId` AND `businessId`

### 3. Collection Config
**File:** `src/lib/rbac/collection-config.ts`

Map collections to their RBAC fields (from semantic layer):
```typescript
{
  UserActivity: { accountIdField: 'accountId', businessIdField: 'businessId' },
  AlertActions: { accountIdField: 'accountId', businessIdField: 'businessId' },
  Translation: {},  // global, no filtering
  // ...
}
```

### 4. Modify ExecuteMongoDB Tool
**File:** `src/lib/tools/execute-mongodb.ts`

- Convert from static tool to factory function `createExecuteMongoDB(user: UserContext)`
- Apply RBAC filter before executing queries
- Keep existing read-only validation

### 5. Pass User Context to Agent
**File:** `src/lib/agent.ts`

- Accept `user: UserContext` parameter
- Create RBAC-aware tool with user context
- Update both `runAgent` and `runAgentWithSandbox`

### 6. Add Authentication to API
**File:** `src/app/api/chat/route.ts`

- Verify authenticated session
- Extract user context from session
- Pass to agent

### 7. JWT Verification
**File:** `src/lib/auth.ts`

Verify JWT from Authorization header:
```typescript
import { jwtVerify, createRemoteJWKSet } from 'jose';

export async function verifyJWT(token: string): Promise<UserContext | null> {
  // Verify with your JWKS endpoint or secret
  const { payload } = await jwtVerify(token, getSigningKey());

  return {
    userId: payload.sub,
    accountId: payload.account_id,
    businessId: payload.business_id,
    accessLevel: payload.role === 'admin' ? 'org_admin' : 'user',
  };
}
```

---

## Files to Modify

| File | Change |
|------|--------|
| `src/lib/rbac/types.ts` | **NEW** - RBAC types |
| `src/lib/rbac/query-rewriter.ts` | **NEW** - Query rewriting logic |
| `src/lib/rbac/collection-config.ts` | **NEW** - Collection → RBAC field mapping |
| `src/lib/tools/execute-mongodb.ts` | Convert to factory, inject RBAC filters |
| `src/lib/agent.ts` | Accept user context, create RBAC tool |
| `src/app/api/chat/route.ts` | Add auth, pass user to agent |
| `src/lib/auth.ts` | **NEW** - JWT verification |

---

## Security Considerations

1. **Tool-level enforcement** - Cannot be bypassed by prompt injection
2. **Whitelist collections** - Only known collections allowed
3. **Audit logging** - Log all queries with user context (future enhancement)
4. **Aggregation safety** - Block `$lookup` to unauthorized collections

---

## Discord Bot

The bot (`src/lib/bot.ts`) also uses the agent. Options:
- Per-guild RBAC (`businessId = guildId`)
- Bot user with elevated access
- Require account linking

---

## Verification

1. Test with different access levels (user, org_admin)
2. Verify queries are filtered correctly
3. Attempt prompt injection to bypass RBAC (should fail)
4. Test both find and aggregate query modes
