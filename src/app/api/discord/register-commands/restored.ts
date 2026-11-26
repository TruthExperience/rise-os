// src/app/api/discord/register-commands/restored.ts
//
// Commands that are implemented and registered in the router but had dropped
// out of the registration manifest. Commit 19526c6 ("Update print statement
// from 'Hello' to 'Goodbye'", 12 Oct 2026) rewrote route.ts from 1,658 lines to
// 118 and deleted the JSON definitions of 23 commands without touching a single
// handler. Discord only knows about the commands POSTed by this route, so those
// commands existed in code and in no guild — /checkin among them, which meant
// drivers had no way to check in at all.
//
// Every object below is restored verbatim from 19526c6^ (the commit before the
// deletion), with checkinStatusChoices inlined as its literal choices. Each was
// checked against what its current handler actually reads from ctx.options;
// none of them needs a handler change, which is why they are registered here
// rather than reworked.
//
// Deliberately absent:
//   - ddv: PR #29 already registers it (with the newer `guide` subcommand), and
//     a second definition here would guarantee a merge conflict.
//   - teams: the handler was removed with the a1f1543-era code, so there is
//     nothing left to register.
// Shape of a Discord application-command payload. Named fields so `name` stays a
// string where the registration loop builds its result rows; the index signature
// keeps the Discord-only keys (channel_types, choices, min_value…) valid.
export interface DiscordCommandDefinition {
  name: string;
  description?: string;
  options?: unknown[];
  default_member_permissions?: string;
  dm_permission?: boolean;
  [key: string]: unknown;
}

export const RESTORED_COMMANDS: DiscordCommandDefinition[] = [
  // /ping
  {
    "name": "ping",
    "description": "Check that the PitBoss bot is alive for this league"
  },
  // /tp
  {
    "name": "tp",
    "description": "View Team Principal assignments",
    "options": [
      {
        "type": 1,
        "name": "view",
        "description": "View a team's Team Principal, or list every team's TP",
        "options": [
          {
            "type": 3,
            "name": "team",
            "description": "Team name (omit to list every team's TP)",
            "required": false
          },
          {
            "type": 3,
            "name": "season",
            "description": "Season code (defaults to the league's current season)",
            "required": false
          }
        ]
      }
    ]
  },
  // /kb
  {
    "name": "kb",
    "description": "Look up league rulebook articles",
    "options": [
      {
        "type": 1,
        "name": "search",
        "description": "Search the rulebook",
        "options": [
          {
            "type": 3,
            "name": "query",
            "description": "What to search for",
            "required": true
          }
        ]
      }
    ]
  },
  // /contract
  {
    "name": "contract",
    "description": "View driver contract details",
    "options": [
      {
        "type": 1,
        "name": "view",
        "description": "View a driver's contract details",
        "options": [
          {
            "type": 6,
            "name": "driver",
            "description": "Driver to look up (defaults to yourself)",
            "required": false
          },
          {
            "type": 3,
            "name": "season",
            "description": "Season (defaults to current)",
            "required": false
          }
        ]
      }
    ]
  },
  // /checkin
  {
    "name": "checkin",
    "description": "Check in (or out) for an upcoming race",
    "options": [
      {
        "type": 3,
        "name": "status",
        "description": "Your attendance status",
        "required": true,
        "choices": [
          {
            "name": "Confirmed",
            "value": "confirmed"
          },
          {
            "name": "Tentative",
            "value": "tentative"
          },
          {
            "name": "Declined",
            "value": "declined"
          },
          {
            "name": "Healer (D2 / reserve / TP)",
            "value": "healer"
          },
          {
            "name": "Damage (commentator)",
            "value": "damage"
          }
        ]
      },
      {
        "type": 3,
        "name": "round",
        "description": "Round number or name (defaults to the next scheduled race)",
        "required": false
      },
      {
        "type": 3,
        "name": "season",
        "description": "Season number (defaults to the round's season)",
        "required": false
      }
    ]
  },
  // /checkin-status
  {
    "name": "checkin-status",
    "description": "View check-in status for a race round (stewards/admins)",
    "options": [
      {
        "type": 3,
        "name": "round",
        "description": "Round number or name (defaults to the next scheduled race)",
        "required": false
      },
      {
        "type": 3,
        "name": "season",
        "description": "Season number (defaults to the round's season)",
        "required": false
      }
    ]
  },
  // /checkin-remind
  {
    "name": "checkin-remind",
    "description": "Ping everyone who hasn't checked in for a race round",
    "options": [
      {
        "type": 3,
        "name": "round",
        "description": "Round number or name (defaults to the next scheduled race)",
        "required": false
      },
      {
        "type": 3,
        "name": "season",
        "description": "Season number (defaults to the round's season)",
        "required": false
      }
    ]
  },
  // /checkin-create
  {
    "name": "checkin-create",
    "description": "Post the race check-in card (track/weather/countdown + buttons) to a division's channel",
    "options": [
      {
        "type": 3,
        "name": "division",
        "description": "Division code (e.g. D1, D2)",
        "required": true
      },
      {
        "type": 3,
        "name": "round",
        "description": "Round number or name (defaults to the next scheduled race)",
        "required": false
      },
      {
        "type": 3,
        "name": "season",
        "description": "Season number (defaults to the round's season)",
        "required": false
      },
      {
        "type": 3,
        "name": "weather",
        "description": "Weather description (e.g. '16°C, Clouds')",
        "required": false
      },
      {
        "type": 3,
        "name": "ping_delivery",
        "description": "How pings are delivered for this race (e.g. 'Channel only', 'Role ping')",
        "required": false
      },
      {
        "type": 3,
        "name": "race_time",
        "description": "Race start time, ISO 8601 (e.g. 2026-09-06T15:00:00Z) — defaults to the round's date at 15:00 UTC",
        "required": false
      },
      {
        "type": 3,
        "name": "track",
        "description": "Manual track/circuit override — use if the calendar's track is missing or wrong for this round",
        "required": false
      },
      {
        "type": 3,
        "name": "country",
        "description": "Manual country override (pairs with track)",
        "required": false
      },
      {
        "type": 3,
        "name": "flag",
        "description": "Manual flag emoji override (e.g. 🇯🇵) — needed for the flag image to render with a manual track",
        "required": false
      }
    ]
  },
  // /members-sync
  {
    "name": "members-sync",
    "description": "Add this server's Discord members to the league (owner / server admin)",
    "dm_permission": false,
    "options": [
      {
        "type": 8,
        "name": "role",
        "description": "Only sync members with this role (use for a small test group)",
        "required": false
      },
      {
        "type": 5,
        "name": "apply",
        "description": "Actually add them (default: preview only, nothing is written)",
        "required": false
      }
    ]
  },
  // /roles
  {
    "name": "roles",
    "description": "Map Discord roles to PitBoss permissions and sync them (owner/co-owner/commissioner/admin)",
    "dm_permission": false,
    "options": [
      {
        "type": 1,
        "name": "map",
        "description": "Link a Discord role to a PitBoss permission",
        "options": [
          {
            "type": 8,
            "name": "role",
            "description": "The Discord role",
            "required": true
          },
          {
            "type": 3,
            "name": "flag",
            "description": "The permission this role grants",
            "required": true,
            "choices": [
              {
                "name": "Co-owner",
                "value": "is_co_owner"
              },
              {
                "name": "Commissioner",
                "value": "is_commissioner"
              },
              {
                "name": "Head steward",
                "value": "is_head_steward"
              },
              {
                "name": "Steward",
                "value": "is_steward"
              },
              {
                "name": "BSAC chief",
                "value": "is_bsac_chief"
              },
              {
                "name": "Team principal",
                "value": "is_team_principal"
              },
              {
                "name": "Driver",
                "value": "is_driver"
              }
            ]
          }
        ]
      },
      {
        "type": 1,
        "name": "unmap",
        "description": "Remove a role's link to a permission",
        "options": [
          {
            "type": 8,
            "name": "role",
            "description": "The Discord role",
            "required": true
          },
          {
            "type": 3,
            "name": "flag",
            "description": "Only remove this permission (omit to remove all for the role)",
            "required": false,
            "choices": [
              {
                "name": "Co-owner",
                "value": "is_co_owner"
              },
              {
                "name": "Commissioner",
                "value": "is_commissioner"
              },
              {
                "name": "Head steward",
                "value": "is_head_steward"
              },
              {
                "name": "Steward",
                "value": "is_steward"
              },
              {
                "name": "BSAC chief",
                "value": "is_bsac_chief"
              },
              {
                "name": "Team principal",
                "value": "is_team_principal"
              },
              {
                "name": "Driver",
                "value": "is_driver"
              }
            ]
          }
        ]
      },
      {
        "type": 1,
        "name": "list",
        "description": "Show which roles are mapped to which permissions"
      },
      {
        "type": 1,
        "name": "sync",
        "description": "Set members' permissions from their Discord roles (preview unless apply is on)",
        "options": [
          {
            "type": 5,
            "name": "apply",
            "description": "Actually write the changes (default: preview only, nothing is written)",
            "required": false
          }
        ]
      }
    ]
  },
  // /generate-grid
  {
    "name": "generate-grid",
    "description": "Build the team lineup grid from confirmed check-ins",
    "options": [
      {
        "type": 3,
        "name": "round",
        "description": "Round number or name (defaults to the next scheduled race)",
        "required": false
      },
      {
        "type": 3,
        "name": "season",
        "description": "Season number (defaults to the round's season)",
        "required": false
      },
      {
        "type": 5,
        "name": "regenerate",
        "description": "Rebuild an existing grid for this round",
        "required": false
      }
    ]
  },
  // /calendar
  {
    "name": "calendar",
    "description": "Set up a season's race calendar (owner/co-owner/commissioner)",
    "dm_permission": false,
    "options": [
      {
        "type": 1,
        "name": "add",
        "description": "Add or update one round on the calendar",
        "options": [
          {
            "type": 4,
            "name": "season",
            "description": "Season number",
            "required": true,
            "min_value": 1
          },
          {
            "type": 4,
            "name": "round",
            "description": "Round number",
            "required": true,
            "min_value": 1
          },
          {
            "type": 3,
            "name": "name",
            "description": "Round name, e.g. Australia Grand Prix",
            "required": true
          },
          {
            "type": 3,
            "name": "date",
            "description": "Race date, YYYY-MM-DD (e.g. 2026-09-06)",
            "required": false
          },
          {
            "type": 3,
            "name": "circuit",
            "description": "Circuit name",
            "required": false
          },
          {
            "type": 3,
            "name": "country",
            "description": "Country",
            "required": false
          },
          {
            "type": 3,
            "name": "flag",
            "description": "Flag emoji (e.g. 🇦🇺) — needed for the flag image on check-in cards",
            "required": false
          },
          {
            "type": 3,
            "name": "division",
            "description": "Division code (omit for a league-wide round)",
            "required": false
          },
          {
            "type": 5,
            "name": "sprint",
            "description": "Sprint weekend?",
            "required": false
          },
          {
            "type": 3,
            "name": "type",
            "description": "Round type (default: race)",
            "required": false,
            "choices": [
              {
                "name": "Race",
                "value": "race"
              },
              {
                "name": "Break",
                "value": "break"
              },
              {
                "name": "Testing",
                "value": "testing"
              }
            ]
          }
        ]
      },
      {
        "type": 1,
        "name": "import",
        "description": "Load a whole season calendar from a CSV file",
        "options": [
          {
            "type": 11,
            "name": "file",
            "description": "CSV with columns: round, name, circuit, country, flag, date, sprint, type",
            "required": true
          },
          {
            "type": 4,
            "name": "season",
            "description": "Season number",
            "required": true,
            "min_value": 1
          },
          {
            "type": 3,
            "name": "division",
            "description": "Division code (omit for league-wide rounds)",
            "required": false
          }
        ]
      },
      {
        "type": 1,
        "name": "list",
        "description": "Show a season's calendar",
        "options": [
          {
            "type": 4,
            "name": "season",
            "description": "Season number (defaults to the latest)",
            "required": false,
            "min_value": 1
          },
          {
            "type": 3,
            "name": "division",
            "description": "Only show this division",
            "required": false
          }
        ]
      },
      {
        "type": 1,
        "name": "remove",
        "description": "Remove a round from the calendar (blocked if it has results)",
        "options": [
          {
            "type": 4,
            "name": "season",
            "description": "Season number",
            "required": true,
            "min_value": 1
          },
          {
            "type": 4,
            "name": "round",
            "description": "Round number",
            "required": true,
            "min_value": 1
          },
          {
            "type": 3,
            "name": "division",
            "description": "Division code (omit for a league-wide round)",
            "required": false
          },
          {
            "type": 3,
            "name": "type",
            "description": "Round type (default: race)",
            "required": false,
            "choices": [
              {
                "name": "Race",
                "value": "race"
              },
              {
                "name": "Break",
                "value": "break"
              },
              {
                "name": "Testing",
                "value": "testing"
              }
            ]
          }
        ]
      }
    ]
  },
  // /set-result
  {
    "name": "set-result",
    "description": "Enter one driver's result for a race (owner/co-owner/commissioner)",
    "dm_permission": false,
    "options": [
      {
        "type": 6,
        "name": "driver",
        "description": "Driver",
        "required": true
      },
      {
        "type": 4,
        "name": "season",
        "description": "Season number",
        "required": true,
        "min_value": 1
      },
      {
        "type": 3,
        "name": "round",
        "description": "Round number or name",
        "required": true
      },
      {
        "type": 4,
        "name": "finish",
        "description": "Finishing position (not needed if DNF)",
        "required": false,
        "min_value": 1
      },
      {
        "type": 4,
        "name": "quali",
        "description": "Qualifying position",
        "required": false,
        "min_value": 1
      },
      {
        "type": 5,
        "name": "dnf",
        "description": "Did not finish?",
        "required": false
      },
      {
        "type": 5,
        "name": "fastest_lap",
        "description": "Set the fastest lap?",
        "required": false
      },
      {
        "type": 10,
        "name": "points",
        "description": "Points override (defaults to the league's points table)",
        "required": false
      },
      {
        "type": 4,
        "name": "sprint_finish",
        "description": "Sprint finishing position",
        "required": false,
        "min_value": 1
      },
      {
        "type": 3,
        "name": "dnf_reason",
        "description": "Reason for the DNF",
        "required": false
      },
      {
        "type": 3,
        "name": "division",
        "description": "Division code (needed if the round exists in more than one division)",
        "required": false
      }
    ]
  },
  // /import-results
  {
    "name": "import-results",
    "description": "Load a whole race's results from a CSV file (owner/co-owner/commissioner)",
    "dm_permission": false,
    "options": [
      {
        "type": 11,
        "name": "file",
        "description": "CSV with columns: driver, finish, quali, dnf, dnf_reason, fastest_lap, points, sprint_finish",
        "required": true
      },
      {
        "type": 4,
        "name": "season",
        "description": "Season number",
        "required": true,
        "min_value": 1
      },
      {
        "type": 3,
        "name": "round",
        "description": "Round number or name",
        "required": true
      },
      {
        "type": 3,
        "name": "division",
        "description": "Division code (needed if the round exists in more than one division)",
        "required": false
      }
    ]
  },
  // /set-standings
  {
    "name": "set-standings",
    "description": "Set a driver's total season points (owner/co-owner/commissioner)",
    "dm_permission": false,
    "options": [
      {
        "type": 6,
        "name": "driver",
        "description": "Driver",
        "required": true
      },
      {
        "type": 4,
        "name": "season",
        "description": "Season number",
        "required": true,
        "min_value": 1
      },
      {
        "type": 10,
        "name": "points",
        "description": "Their total points for the season",
        "required": true
      },
      {
        "type": 3,
        "name": "reason",
        "description": "Why (saved with the adjustment)",
        "required": false
      }
    ]
  },
  // /results
  {
    "name": "results",
    "description": "View the results for a race round (defaults to the most recent round with results)",
    "options": [
      {
        "type": 3,
        "name": "round",
        "description": "Round number or name (defaults to the most recent round with results)",
        "required": false
      },
      {
        "type": 3,
        "name": "season",
        "description": "Season (defaults to the most recent season with recorded results)",
        "required": false
      }
    ]
  },
  // /exam
  {
    "name": "exam",
    "description": "Get the link to take a certification exam"
  },
  // /cert
  {
    "name": "cert",
    "description": "View your active certifications in this league"
  },
  // /kick
  {
    "name": "kick",
    "description": "Kick a member from the server (owner/co-owner only)",
    "default_member_permissions": "2",
    "dm_permission": false,
    "options": [
      {
        "type": 6,
        "name": "user",
        "description": "Member to kick",
        "required": true
      },
      {
        "type": 3,
        "name": "reason",
        "description": "Reason for the kick",
        "required": false
      }
    ]
  },
  // /ban
  {
    "name": "ban",
    "description": "Ban a member from the server (owner/co-owner only)",
    "default_member_permissions": "4",
    "dm_permission": false,
    "options": [
      {
        "type": 6,
        "name": "user",
        "description": "Member to ban",
        "required": true
      },
      {
        "type": 3,
        "name": "reason",
        "description": "Reason for the ban",
        "required": false
      }
    ]
  },
  // /lockdown
  {
    "name": "lockdown",
    "description": "Lock down the server (owner/co-owner only)",
    "default_member_permissions": "8",
    "dm_permission": false,
    "options": [
      {
        "type": 3,
        "name": "reason",
        "description": "Reason for the lockdown",
        "required": false
      }
    ]
  },
  // /endlockdown
  {
    "name": "endlockdown",
    "description": "Lift an active server lockdown (owner/co-owner only)",
    "default_member_permissions": "8",
    "dm_permission": false
  },
];
