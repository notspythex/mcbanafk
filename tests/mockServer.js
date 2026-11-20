'use strict';
// A small REAL Minecraft (protocol-level) offline-mode server that imitates a login plugin + proxy:
//  - sends "Please /login <password>" after join
//  - checks "/login <pw>", replies success / wrong password
//  - on "/server <name>" re-sends a login packet (what a BungeeCord/Velocity transfer looks like to the client)
const mc = require('minecraft-protocol');
const nbt = require('prismarine-nbt');

function createMock({ password, version = '1.20.4', port = 0, requireLogin = true } = {}) {
  const server = mc.createServer({ 'online-mode': false, host: '127.0.0.1', port, version, motd: 'mock', 'max-players': 20 });
  const mcData = require('minecraft-data')(server.version);
  const loginPacket = mcData.loginPacket;
  const state = { joins: [], commands: [], clients: new Map() };

  const text = (t) => (mcData.supportFeature('chatPacketsUseNbtComponents') ? nbt.comp({ text: nbt.string(t) }) : JSON.stringify({ text: t }));
  const say = (client, t) => client.write('system_chat', { content: text(t), isActionBar: false });
  const sendLogin = (client, worldName) => {
    client.write('login', { ...loginPacket, enforceSecureChat: false, entityId: client.id, isHardcore: false, gameMode: 0, previousGameMode: 1, hashedSeed: [0, 0], maxPlayers: 20, viewDistance: 8, reducedDebugInfo: false, enableRespawnScreen: true, isDebug: false, isFlat: false, worldName: worldName || loginPacket.worldName });
    client.write('position', { x: 0, y: 64, z: 0, yaw: 0, pitch: 0, flags: 0, teleportId: 0 });
    client.write('update_health', { health: 20, food: 20, foodSaturation: 5 });
  };

  server.on('playerJoin', (client) => {
    state.joins.push(client.username);
    state.clients.set(client.username, client);
    client.authed = !requireLogin;
    sendLogin(client);
    if (requireLogin) setTimeout(() => say(client, 'Please /login <password>'), 100);

    const onCommand = (raw) => {
      const cmd = raw.startsWith('/') ? raw.slice(1) : raw;
      state.commands.push({ user: client.username, cmd });
      const [name, ...args] = cmd.split(' ');
      if (name === 'login') {
        if (args[0] === password) { client.authed = true; say(client, 'Successfully logged in!'); }
        else say(client, 'Wrong password!');
      } else if (name === 'server') {
        if (!client.authed) return say(client, 'You must log in first');
        if (args[0] === 'randomkits') setTimeout(() => sendLogin(client, 'minecraft:randomkits'), 150);
        else say(client, `Could not connect to target server`);
      }
    };
    client.on('chat_command', (d) => onCommand(d.command));
    client.on('chat_command_signed', (d) => onCommand(d.command));
    client.on('chat_message', (d) => onCommand(d.message));
    client.on('end', () => { if (state.clients.get(client.username) === client) state.clients.delete(client.username); });
  });

  return new Promise((resolve) => server.on('listening', () => resolve({
    port: server.socketServer.address().port,
    state,
    kick: (name, reason = 'kicked by test') => { const c = state.clients.get(name); if (c) c.end(reason); return !!c; },
    close: () => new Promise((r) => { for (const c of Object.values(server.clients)) c.end('shutdown'); server.close(); setTimeout(r, 50); }),
  })));
}

module.exports = { createMock };
