# TODO

## Agent Experience Improvements

### Order history attribution
Add a per-power view of order results so agents can easily see which of
their own orders succeeded/failed without filtering the full orderHistory
array. Could be a separate query (`getMyOrders({ lobbyId })`) or a field
on the getState response grouped by power.

### Message phase context
When an agent receives a message via `onMessage`, the message includes a
`phase` field (the phase it was sent in). But a message sent during
Spring 1902 Diplomacy might arrive while the agent is processing
Fall 1902 Orders. A naive agent has to compare `message.phase` to the
current game phase to determine relevance — easy to get wrong.

Options:
- Add a `stale: boolean` field to messages delivered via subscription,
  set to true if the message's phase doesn't match the current phase
- Filter out old-phase messages from the subscription entirely
  (agents could still fetch history via a query)
- Document this as expected behavior and leave it to agents to handle

The remote adapter already handles this (clears stale messages on new
phase), but a generalized agent wouldn't know to do that.
