# Remind clients the day before an appointment

- **Type:** feature
- **Size:** M
- **Spec version:** 1

## Problem

Clients forget lessons booked weeks ahead, and the coach finds out when
nobody shows up. A confirmed booking sends nothing after its confirmation.

## Acceptance criteria

### AC-1: A reminder goes out the day before

- **Given** a confirmed booking with an appointment starting in 24 hours
- **When** the reminder sweep runs
- **Then** the client gets one email naming the business, the students and the start time in the business's time zone

### AC-2: A cancelled booking sends nothing

- **Given** a booking cancelled before its reminder is due
- **When** the reminder sweep runs
- **Then** no email is sent for it

## Non-goals

- Text messages.
- Letting a client choose when the reminder arrives.

## Success metrics

- At least 95% of appointments have a reminder sent 23 to 25 hours ahead, over 14 days (signal: `booking_reminders_sent_total` against confirmed appointments)
- The sweep finishes in under 300 ms at p95 (signal: `reminder_sweep_duration_seconds`)
