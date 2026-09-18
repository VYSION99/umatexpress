# Hostel Finder — Chat & Instant Messaging Integration

**Status:** Approved  
**Part of:** Hostel Finder (extends the main architecture)  
**Goal:** Enable reliable, auditable, real-time 1:1 messaging between students and landlords, tightly integrated with the existing Hostel Finder booking flow.

---

## 1. Integration with Hostel Finder

Chat is **not** a separate product. It is a core communication layer inside the Hostel Finder, scoped to active bookings.

### Relationship to Existing Entities

| Entity | Chat Relationship |
|--------|-------------------|
| `hostel_bookings` | **Primary scope** — Every chat channel is tied to one booking |
| `hostel_landlords` | One side of the conversation (landlord) |
| `hostel_properties` | Context for the chat (property details shown in chat header) |
| `hostel_messages` | New table — stores all messages for durability and audit |
| `hostel_payouts` | Indirect — chat history can be used as supporting evidence in disputes |

**Channel naming rule (strict):**
```
hostel:booking:{bookingReference}
```

Example: `hostel:booking:HF-2026A7B2C`

---

## 2. Chat Features (v1 Scope)

| Feature | Included in v1 | Notes |
|---------|----------------|-------|
| 1:1 messaging (student ↔ landlord) | Yes | Scoped to a booking |
| Typing indicators | Yes | Ably presence |
| Read receipts | Yes | Stored per participant |
| Message history | Yes | Loaded from Turso |
| Admin view-only access | Yes | From admin console |
| File / image sharing | No | Deferred to Phase 3 |
| Group chat | No | Out of scope |
| Pre-booking inquiries | No | Can be added later via `hostel:property:{id}` |

---

## 3. Technical Architecture

### Components

| Component | Location | Purpose |
|---------|----------|---------|
| `lib/hostel-engine/chat/auth.ts` | New | Issue Ably tokens scoped to a booking |
| `lib/hostel-engine/chat/messages.ts` | New | Persist and retrieve messages from Turso |
| `lib/hostel-engine/chat/presence.ts` | New | Typing + online status helpers |
| `app/api/hostel/chat/token/route.ts` | New | Token issuance endpoint |
| `app/api/hostel/chat/messages/route.ts` | New | REST history endpoint |
| `components/hostel/ChatWidget.tsx` | New | Reusable chat component for both student and landlord UIs |
| `app/landlord/bookings/[reference]/chat` | New | Landlord chat view |
| `app/hostel/bookings/[reference]/chat` | New | Student chat view |

### Message Schema

```sql
CREATE TABLE hostel_messages (
  id TEXT PRIMARY KEY,
  booking_id TEXT NOT NULL REFERENCES hostel_bookings(id),
  sender_type TEXT NOT NULL,           -- 'student' | 'landlord' | 'admin'
  sender_id TEXT NOT NULL,
  content TEXT NOT NULL,
  metadata TEXT,                       -- JSON (edited, system, etc.)
  created_at TEXT NOT NULL,
  updated_at TEXT
);

CREATE INDEX idx_hostel_messages_booking_created 
ON hostel_messages(booking_id, created_at DESC);
```

---

## 4. Authentication & Permissions

### Token Issuance Flow

1. User opens a booking chat.
2. Frontend calls:
   ```
   POST /api/hostel/chat/token
   { bookingReference: "HF-..." }
   ```
3. Worker validates:
   - User has a valid landlord or student session.
   - The booking belongs to the landlord’s property **or** the student who made the booking.
4. Worker generates a short-lived Ably token with capabilities limited to:
   ```json
   {
     "capability": {
       "hostel:booking:HF-2026A7B2C": ["publish", "subscribe", "presence"]
     }
   }
   ```
5. Token is returned and used to initialize the Ably client.

**Security rules:**
- A landlord cannot access chats for bookings they do not own.
- A student cannot access chats for bookings they did not make.
- Admin tokens are issued separately with read-only access.

---

## 5. UI Integration Points

### Landlord Console
- In the landlord’s booking list, each booking row has a **“Chat”** button.
- Opens a chat panel or dedicated route showing:
  - Property name + student name
  - Message history
  - Typing indicator
  - Send message input

### Student Console
- After booking confirmation, a **“Message Landlord”** button appears.
- Chat is accessible from the booking ticket page and booking history.

### Admin Console
- Admin can view any booking’s chat history (read-only).
- Useful for dispute resolution and moderation.

---

## 6. Message Persistence Strategy

**Dual-write model** (recommended for reliability):

1. Message is published to Ably (instant delivery).
2. A server-side process (Ably webhook or Worker) writes the message to `hostel_messages`.
3. If the database write fails, the message is still delivered in realtime, and a retry mechanism attempts to persist it later.

This ensures:
- Excellent realtime experience (via Ably)
- Durable, auditable history (via Turso)
- Easy admin search and export

---

## 7. Phased Delivery Within Hostel Finder

### Phase 2 (alongside booking + payments)
- Token issuance endpoint
- Basic 1:1 text messaging
- Message persistence to Turso
- Chat widget embedded in booking views

### Phase 3 (alongside payouts & trust)
- Typing indicators + presence
- Read receipts
- Admin chat viewer with search
- System messages (e.g. “Booking confirmed”, “Payment received”)

### Phase 4 (polish)
- File sharing (R2 + Ably)
- AI-assisted moderation
- Push notifications for new messages

---

## 8. Security & Audit

- All chat access is controlled through the existing `hostel_landlords` and booking ownership model.
- Every message write triggers an audit entry in `hostel_audit_logs`.
- Payout account masking rules also apply to chat (no sensitive financial details should be discussed in chat).
- Rate limiting is applied on both token issuance and message sending.

---

## 9. Open Items

| Item | Decision Needed |
|------|-----------------|
| Push notification provider | Cloudflare + Ably or external service |
| Message encryption at rest | Deferred |
| Maximum message length | 2000 characters (recommended) |
| Message editing / deletion | Not in v1 |

---

This document extends the main `HOSTEL_FINDER_ARCHITECTURE.md` and should be read together with it. Chat becomes a natural communication layer on top of the booking entity.