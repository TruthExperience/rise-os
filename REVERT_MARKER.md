# Revert Marker

This file marks the revert of broken CommandContext optionality changes.

Reverted commits:
- e50ac56: Placeholder for reset tracking
- c829cd4: Add non-null assertion for leagueId in appeal.ts
- dfa3180: Fix optional chaining for leagueId in appeal command
- c10d7da: Refactor routeCommand to handle optional guildId
- 1295d37: Make CommandContext properties optional and update command registration

Reverted back to: 20dc2bc (Refactor evidence parameter in command route)
