# Plan: Remind clients the day before an appointment

- **Ticket:** ABC-0
- **Spec version:** 1
- **Plan version:** 1

## Design

Scheduling already sweeps expired holds every 15 seconds with `FOR UPDATE
SKIP LOCKED` (ADR 0008). Reminders follow the same pattern: a sweep picks
confirmed appointments starting in 23 to 25 hours that have no
`reminder_sent_at`, sends, and stamps them in the same transaction, so two
replicas never send twice.

## Tasks

### T-1: Record when a reminder was sent

- **Covers:** AC-2
- **Size:** S
- **Depends on:** none
- **Changes:** a migration adding `appointments.reminder_sent_at`; the store method that picks due appointments, skipping cancelled bookings.
- **Tests:** a store test against Postgres that a cancelled booking's appointment is never picked.

### T-2: Send the reminder from a sweep

- **Covers:** AC-1, AC-2
- **Size:** M
- **Depends on:** T-1
- **Changes:** the sweep, the email, and the `booking_reminders_sent_total` and `reminder_sweep_duration_seconds` metrics.
- **Tests:** a service test with a fake mailer that one email goes out with the business's time zone; against the local stack, a booking 24 hours out gets one email and a cancelled one gets none.

## Risks

- A slow mail provider holds the sweep's transaction open. The send has a 5 second timeout and the row is stamped only on success.
