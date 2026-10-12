// One-off: registers /signups with all six subcommands (open, resume, status,
// list, close, test). POSTing a command with an existing name overwrites it,
// so this must contain EVERY subcommand, not just the new one.
//
// Run:  node register-signups-command.mjs
// Env:  PITBOSS_DISCORD_BOT_TOKEN, DISCORD_APPLICATION_ID
//       DISCORD_GUILD_ID  (optional: set to register in ONE server, e.g. VRC,
//                          and it updates instantly. Omit for a global command.)

const token = process.env.PITBOSS_DISCORD_BOT_TOKEN
const appId = process.env.DISCORD_APPLICATION_ID
const guildId = process.env.DISCORD_GUILD_ID

if (!token || !appId) {
  console.error('Set PITBOSS_DISCORD_BOT_TOKEN and DISCORD_APPLICATION_ID')
  process.exit(1)
}

// Option types: 1 = SUB_COMMAND, 3 = STRING, 4 = INTEGER, 6 = USER
const command = {
  name: 'signups',
  description: 'Manage season signups (owners only)',
  options: [
    {
      type: 1,
      name: 'open',
      description: 'Open signups and DM every league member',
      options: [
        {
          type: 4,
          name: 'season',
          description: "Season number (default: the league's latest upcoming season)",
          required: false,
        },
        {
          type: 3,
          name: 'message',
          description: 'Custom DM text (optional)',
          required: false,
        },
      ],
    },
    {
      type: 1,
      name: 'resume',
      description: 'Keep sending queued DMs after a timeout',
    },
    {
      type: 1,
      name: 'status',
      description: 'Counts for the open signup round',
    },
    {
      type: 1,
      name: 'list',
      description: 'Names for the open signup round',
      options: [
        {
          type: 3,
          name: 'show',
          description: 'Which group to list (default: signed up)',
          required: false,
          choices: [
            { name: 'Signed up', value: 'signed_up' },
            { name: 'Declined', value: 'declined' },
            { name: 'No answer yet', value: 'pending' },
            { name: "Couldn't DM", value: 'dm_failed' },
            { name: 'Everyone', value: 'all' },
          ],
        },
      ],
    },
    {
      type: 1,
      name: 'close',
      description: 'Close the open signup round',
    },
    {
      type: 1,
      name: 'test',
      description: 'Send one test signup invite to a single user (nothing is saved)',
      options: [
        {
          type: 6,
          name: 'user',
          description: 'Who to send the test invite to',
          required: true,
        },
        {
          type: 4,
          name: 'season',
          description: 'Season number for the invite (default: 2)',
          required: false,
        },
      ],
    },
  ],
}

const url = guildId
  ? `https://discord.com/api/v10/applications/${appId}/guilds/${guildId}/commands`
  : `https://discord.com/api/v10/applications/${appId}/commands`

const res = await fetch(url, {
  method: 'POST',
  headers: {
    Authorization: `Bot ${token}`,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify(command),
})

const json = await res.json().catch(() => ({}))
if (!res.ok) {
  console.error('Registration failed:', res.status, JSON.stringify(json, null, 2))
  process.exit(1)
}
console.log(`Registered /signups (${guildId ? 'guild ' + guildId : 'global'}), id ${json.id}`)
