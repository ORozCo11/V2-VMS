# Ticketing process: dataflow (12 November 2026)

Roles: **Custodian** proposes, resubmits corrections, hands external jobs to the shop and verifies. **Admin** approves, returns for corrections, declines, assigns mechanics and testers, cancels and reassigns. **Maintenance Personnel** (mechanic) repairs, tests and submits, or returns the work to the Admin.

```
Ticket status:    Pending Approval -> Active -> For Verification -> Closed
                  side branches: Declined, Cancelled
Work item status: Under Repair -> For Inspection -> (Done when the ticket closes)
                  (a work item is one line of work on a ticket)
```

## 1. How a ticket starts (always a proposal)

```
Condition Check says "Needs Repair"        A maintenance schedule becomes due
  -> repair request opens on the same page   -> the system auto-creates a proposal
  -> findings auto-fill                       -> links the schedule to it
  -> Custodian picks repair type, submits
              \                                 /
               v                               v
        TICKET = PENDING APPROVAL
          vehicle condition: Good -> Needs Repair (if it was Good)
          Admins notified
```
Repair types: In-house, Cannibalized (parts from a retired vehicle), External shop. The Admin has no "create ticket" button.

## 2. The Admin's decision

```
                    PENDING APPROVAL
          +---------------+-----------------+
       APPROVE      REQUEST CORRECTIONS    DECLINE
          |                 |                 |
   Active; vehicle     stays Pending,      Declined (reason)
   -> Under            reason; Custodian   Custodian told: the vehicle stays
   Maintenance         edits + RESUBMITS   Needs Repair until a new
   mechanic per        (must change        Condition Check
   in-house item;      something)               |
   shop tester per     -> back to Admin    RECONSIDER -> Pending Approval
   external item
```

## 3. The work (per work item, Under Repair)

```
IN-HOUSE / CANNIBALIZED            EXTERNAL SHOP                    NO REPAIR NEEDED
mechanic writes work, parts,       Custodian marks SENT, then       mechanic checks, finds
cost, photos (cannibalized: pick   RETURNED. The NAMED SHOP TESTER  nothing, gives a reason
a retired donor and its parts)     tests it when it returns         -> For Inspection
        \                                |                          (no maintenance record)
         +-------------+-----------------+
                       v
   mechanic / tester ticks "I tested the vehicle and it is working" -> SUBMIT REPAIR LOG
   work item -> For Inspection; when EVERY item is For Inspection: ticket -> FOR VERIFICATION

RETURN TO ADMIN (mechanic or shop tester, reason required, while the item is Under Repair)
   -> item stays Under Repair with nobody assigned; the return and its reason show on the ticket
   -> Admin AND Custodian are notified; Next Step reads "Returned to Admin - needs reassignment"
   -> the Admin reassigns the mechanic (or names a new shop tester), or cancels the ticket
   -> reassigning clears the return notice
```

## 4. Verification (the Custodian signs off)

```
                     FOR VERIFICATION (assigned Custodian only)
              +-----------------+------------------+
           APPROVE                              REJECT
   Custodian confirms they tested it      needs a failed check or a note
   every item Done, maintenance           items -> Under Repair, ticket -> Active
   record written, ticket CLOSED          mechanic notified; re-logs the repair
   (archived), vehicle back to            -> For Verification again (same Custodian)
   Available, a fresh readiness check
   is required, linked schedule done
```
A Custodian who did repair work on the ticket cannot verify it; the Admin reassigns the verification.

## 5. Other changes of state

- **Cancel** (Admin, reason): from Active or For Verification. Blocked if all work is complete or an external job is still at the shop. **Restore** a cancelled, never-closed ticket.
- **Delete** (Admin): only Pending, Declined or Cancelled tickets with no repair or cost evidence.
- **Archive:** a Closed ticket is archived automatically; the Admin can reopen it.
- **Reassign Custodian / Mechanic** (Admin); **add a work item** while Active.

## 6. Removed on 12 November 2026 (they could not be reached by any role)

Direct ticket creation by the Admin, the Custodian inspection step and the "Open" status, per-item mechanic assign and reassign, per-item verify and confirm, defer, the Admin "Close" button and "Unconfirm". The statuses "For Confirmation" and "Deferred" are no longer used. Closing is done only by the Custodian's verification.
