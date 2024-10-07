/* eslint-disable no-underscore-dangle */
const config = require('config');
const zeltrezjs = require('zeltrezjs');
const nodecmd = require('node-cmd');
const fs = require('fs').promises;
const path = require('path');
const os = require('os');
// eslint-disable-next-line import/no-extraneous-dependencies
const util = require('util');
const { LRUCache } = require('lru-cache');
const log = require('../lib/log');
const serviceHelper = require('./serviceHelper');
const messageHelper = require('./messageHelper');
const daemonServiceMiscRpcs = require('./daemonService/daemonServiceMiscRpcs');
const daemonServiceUtils = require('./daemonService/daemonServiceUtils');
const daemonServiceFluxnodeRpcs = require('./daemonService/daemonServiceFluxnodeRpcs');
const daemonServiceBenchmarkRpcs = require('./daemonService/daemonServiceBenchmarkRpcs');
const daemonServiceWalletRpcs = require('./daemonService/daemonServiceWalletRpcs');
const benchmarkService = require('./benchmarkService');
const verificationHelper = require('./verificationHelper');
const fluxCommunicationUtils = require('./fluxCommunicationUtils');
const {
  outgoingConnections, outgoingPeers, incomingPeers, incomingConnections,
} = require('./utils/establishedConnections');

let dosState = 0; // we can start at bigger number later
let dosMessage = null;

let storedFluxBenchAllowed = null;
let ipChangeData = null;
let dosTooManyIpChanges = false;
let maxNumberOfIpChanges = 0;

// default cache
const LRUoptions = {
  max: 1,
  ttl: 24 * 60 * 60 * 1000, // 1 day
  maxAge: 24 * 60 * 60 * 1000, // 1 day
};

const myCache = new LRUCache(LRUoptions);

// my external Flux IP from benchmark
let myFluxIP = null;

let response = messageHelper.createErrorMessage();

const axiosConfig = {
  timeout: 5000,
};

const buckets = new Map();

class TokenBucket {
  constructor(capacity, fillPerSecond) {
    this.capacity = capacity;
    this.fillPerSecond = fillPerSecond;

    this.lastFilled = Date.now();
    this.tokens = capacity;
  }

  take() {
    // Calculate how many tokens (if any) should have been added since the last request
    this.refill();

    if (this.tokens > 0) {
      this.tokens -= 1;
      return true;
    }

    return false;
  }

  refill() {
    const now = Date.now();
    const rate = (now - this.lastFilled) / (this.fillPerSecond * 1000);

    this.tokens = Math.min(this.capacity, this.tokens + Math.floor(rate * this.capacity));
    this.lastFilled = now;
  }
}

/**
 * To get if port belongs to enterprise range
 * @returns {boolean} Returns true if enterprise
 */
function isPortEnterprise(port) {
  const { enterprisePorts } = config.fluxapps;
  let portEnterprise = false;
  enterprisePorts.forEach((portOrInterval) => {
    if (typeof portOrInterval === 'string') { // '0-10'
      const minPort = Number(portOrInterval.split('-')[0]);
      const maxPort = Number(portOrInterval.split('-')[1]);
      if (+port >= minPort && +port <= maxPort) {
        portEnterprise = true;
      }
    } else if (portOrInterval === +port) {
      portEnterprise = true;
    }
  });
  return portEnterprise;
}

/**
 * To get if port belongs to user blocked range
 * @returns {boolean} Returns true if port is user blocked
 */
function isPortUserBlocked(port) {
  try {
    let blockedPorts = userconfig.initial.blockedPorts || [];
    blockedPorts = serviceHelper.ensureObject(blockedPorts);
    let portBanned = false;
    blockedPorts.forEach((portOrInterval) => {
      if (portOrInterval === +port) {
        portBanned = true;
      }
    });
    return portBanned;
  } catch (error) {
    log.error(error);
    return false;
  }
}

/**
 * To get if port belongs to banned range
 * @returns {boolean} Returns true if port is banned
 */
function isPortBanned(port) {
  const { bannedPorts } = config.fluxapps;
  let portBanned = false;
  bannedPorts.forEach((portOrInterval) => {
    if (typeof portOrInterval === 'string') { // '0-10'
      const minPort = Number(portOrInterval.split('-')[0]);
      const maxPort = Number(portOrInterval.split('-')[1]);
      if (+port >= minPort && +port <= maxPort) {
        portBanned = true;
      }
    } else if (portOrInterval === +port) {
      portBanned = true;
    }
  });
  return portBanned;
}

/**
 * To get if port belongs to banned upnp range
 * @returns {boolean} Returns true if port is banned
 */
function isPortUPNPBanned(port) {
  let portBanned = false;
  const { upnpBannedPorts } = config.fluxapps;
  upnpBannedPorts.forEach((portOrInterval) => {
    if (typeof portOrInterval === 'string') { // '0-10'
      const minPort = Number(portOrInterval.split('-')[0]);
      const maxPort = Number(portOrInterval.split('-')[1]);
      if (+port >= minPort && +port <= maxPort) {
        portBanned = true;
      }
    } else if (portOrInterval === +port) {
      portBanned = true;
    }
  });
  return portBanned;
}

/**
 * To perform a basic check if port on an ip is opened
 * @param {string} ip IP address.
 * @param {number} port Port.
 * @returns {boolean} Returns true if opened, otherwise false
 */
async function isPortOpen(ip, port) {
  try {
    const exec = `nc -w 5 -z -v ${ip} ${port} </dev/null; echo $?`;
    const cmdAsync = util.promisify(nodecmd.get);
    const result = await cmdAsync(exec);
    return !+result;
  } catch (error) {
    log.error(error);
    return false;
  }
}

/**
 * To perform a basic check of current FluxOS version.
 * @param {string} ip IP address.
 * @param {string} port Port. Defaults to config.server.apiport.
 * @returns {boolean} False unless FluxOS version meets or exceeds the minimum allowed version.
 */
async function isFluxAvailable(ip, port = config.server.apiport) {
  try {
    const ipchars = /^[0-9.]+$/;
    if (!ipchars.test(ip)) {
      throw new Error('Invalid IP');
    }
    if (!config.server.allowedPorts.includes(+port)) {
      throw new Error('Invalid Port');
    }
    const fluxResponse = await serviceHelper.axiosGet(`http://${ip}:${port}/flux/version`, axiosConfig);
    if (fluxResponse.data.status !== 'success') return false;

    const fluxVersion = fluxResponse.data.data;
    const versionMinOK = serviceHelper.minVersionSatisfy(fluxVersion, config.minimumFluxOSAllowedVersion);
    if (!versionMinOK) return false;

    const homePort = +port - 1;
    const fluxResponseUI = await serviceHelper.axiosGet(`http://${ip}:${homePort}`, axiosConfig);
    const UIok = fluxResponseUI.data.includes('<title>');
    if (!UIok) return false;

    const syncthingPort = +port + 2;
    const portOpen = await isPortOpen(ip, syncthingPort);
    return portOpen;
  } catch (e) {
    log.error(e);
    return false;
  }
}

/**
 * To check Flux availability for specific IP address/port.
 * @param {object} req Request.
 * @param {object} res Response.
 * @returns {object} Message.
 */
async function checkFluxAvailability(req, res) {
  let { ip } = req.params;
  ip = ip || req.query.ip;
  let { port } = req.params;
  port = port || req.query.port;
  if (ip === undefined || ip === null) {
    const errMessage = messageHelper.createErrorMessage('No ip specified.');
    return res.json(errMessage);
  }

  const available = await isFluxAvailable(ip, port);

  if (available === true) {
    const message = messageHelper.createSuccessMessage('Asking Flux is available');
    response = message;
  } else {
    const message = messageHelper.createErrorMessage('Asking Flux is not available');
    response = message;
  }
  return res.json(response);
}

/**
 * To check if application is available
 * @param {object} req Request.
 * @param {object} res Response.
 * @returns {object} Message.
 */
async function checkAppAvailability(req, res) {
  let body = '';
  req.on('data', (data) => {
    body += data;
  });
  req.on('end', async () => {
    try {
      const authorized = await verificationHelper.verifyPrivilege('adminandfluxteam', req);

      const processedBody = serviceHelper.ensureObject(body);

      const {
        ip, ports, pubKey, signature,
      } = processedBody;

      const ipPort = processedBody.port;

      // pubkey of the message has to be on the list
      const zl = await fluxCommunicationUtils.deterministicFluxList(pubKey); // this itself is sufficient.
      const node = zl.find((key) => key.pubkey === pubKey); // another check in case sufficient check failed on daemon level
      const dataToVerify = processedBody;
      delete dataToVerify.signature;
      const messageToVerify = JSON.stringify(dataToVerify);
      const verified = verificationHelper.verifyMessage(messageToVerify, pubKey, signature);
      if ((verified !== true || !node) && authorized !== true) {
        throw new Error('Unable to verify request authenticity');
      }

      const syncStatus = daemonServiceMiscRpcs.isDaemonSynced();
      const daemonHeight = syncStatus.data.height;
      const minPort = daemonHeight >= config.fluxapps.portBlockheightChange ? config.fluxapps.portMinNew : config.fluxapps.portMin - 1000;
      const maxPort = daemonHeight >= config.fluxapps.portBlockheightChange ? config.fluxapps.portMaxNew : config.fluxapps.portMax;
      // eslint-disable-next-line no-restricted-syntax
      for (const port of ports) {
        const iBP = isPortBanned(+port);
        if (+port >= minPort && +port <= maxPort && !iBP) {
          // eslint-disable-next-line no-await-in-loop
          const isOpen = await isPortOpen(ip, port);
          if (!isOpen) {
            throw new Error(`Flux Applications on ${ip}:${ipPort} are not available. Failed port: ${port}`);
          }
        } else {
          log.error(`Flux App port ${port} is outside allowed range.`);
        }
      }
      const successResponse = messageHelper.createSuccessMessage(`Flux Applications on ${ip}:${ipPort} are available.`);
      res.json(successResponse);
    } catch (error) {
      const errorResponse = messageHelper.createErrorMessage(
        error.message || error,
        error.name,
        error.code,
      );
      res.json(errorResponse);
    }
  });
}

/**
 * Setter for myFluxIp.
 * Main goal for this is testing availability.
 *
 * @param {string} value new IP to be set
 */
function setMyFluxIp(value) {
  myFluxIP = value;
}

/**
 * Setter for dosMessage.
 * Main goal for this is testing availability.
 *
 * @param {string} message New message
 */
function setDosMessage(message) {
  dosMessage = message;
}

/**
 * Getter for dosMessage.
 * Main goal for this is testing availability.
 *
 * @returns {string} dosMessage
 */
function getDosMessage() {
  return dosMessage;
}

/**
 * Setter for dosState.
 * Main goal for this is testing availability.
 *
 * @param {number} sets dosState
 */
function setDosStateValue(value) {
  dosState = value;
}

/**
 * Getter for dosState.
 * Main goal for this is testing availability.
 *
 * @returns {number} dosState
 */
function getDosStateValue() {
  return dosState;
}

/**
 * To get Flux IP adress and port.
 * @returns {string} IP address and port.
 */
async function getMyFluxIPandPort() {
  const benchmarkResponse = await daemonServiceBenchmarkRpcs.getBenchmarks();
  let myIP = null;
  if (benchmarkResponse.status === 'success') {
    const benchmarkResponseData = JSON.parse(benchmarkResponse.data);
    if (benchmarkResponseData.ipaddress) {
      myIP = benchmarkResponseData.ipaddress.length > 5 ? benchmarkResponseData.ipaddress : null;
    }
  }
  setMyFluxIp(myIP);
  return myIP;
}

/**
 * To get FluxNode private key.
 * @param {string} privatekey Private Key.
 * @returns {string} Private key, if already input as parameter or otherwise from the daemon config.
 */
async function getFluxNodePrivateKey(privatekey) {
  const privKey = privatekey || daemonServiceUtils.getConfigValue('zelnodeprivkey');
  return privKey;
}

/**
 * To get FluxNode public key.
 * @param {string} privatekey Private key.
 * @returns {string} Public key.
 */
async function getFluxNodePublicKey(privatekey) {
  try {
    const pkWIF = await getFluxNodePrivateKey(privatekey);
    const isCompressed = !pkWIF.startsWith('5');
    const privateKey = zeltrezjs.address.WIFToPrivKey(pkWIF);
    const pubKey = zeltrezjs.address.privKeyToPubKey(privateKey, isCompressed);
    return pubKey;
  } catch (error) {
    return error;
  }
}

/**
 * To get a random connection.
 * @returns {string} IP:Port or just IP if default.
 */
async function getRandomConnection() {
  const nodeList = await fluxCommunicationUtils.deterministicFluxList();
  const zlLength = nodeList.length;
  if (zlLength === 0) {
    return null;
  }
  const randomNode = Math.floor((Math.random() * zlLength)); // we do not really need a 'random'
  const ip = nodeList[randomNode].ip || nodeList[randomNode].ipaddress;
  const apiPort = userconfig.initial.apiport || config.server.apiport;

  if (!ip || !myFluxIP || ip === userconfig.initial.ipaddress || ip === myFluxIP || ip === `${userconfig.initial.ipaddress}:${apiPort}` || ip.split(':')[0] === myFluxIP.split(':')[0]) {
    return null;
  }
  return ip;
}

/**
 * To close an outgoing connection.
 * @param {string} ip IP address.
 * @param {string} port node API port.
 * @returns {object} Message.
 */
async function closeConnection(ip, port) {
  if (!ip) return messageHelper.createWarningMessage('To close a connection please provide a proper IP number.');
  const peerIndex = outgoingPeers.findIndex((peer) => peer.ip === ip && peer.port === port);
  if (peerIndex > -1) {
    outgoingPeers.splice(peerIndex, 1);
  }
  const ocIndex = outgoingConnections.findIndex((client) => client.ip === ip && client.port === port);
  if (ocIndex < 0) {
    return messageHelper.createWarningMessage(`Connection to ${ip}:${port} does not exists.`);
  }
  const wsObj = outgoingConnections[ocIndex];
  wsObj.close(4009, 'purpusfully closed');
  log.info(`Connection to ${ip}:${port} closed with code 4009`);
  outgoingConnections.splice(ocIndex, 1);
  return messageHelper.createSuccessMessage(`Outgoing connection to ${ip}:${port} closed`);
}

/**
 * To close an incoming connection.
 * @param {string} ip IP address.
 * @param {string} port node API port.
 * @param {object} expressWS Express web socket.
 * @param {object} clientToClose Web socket for client to close.
 * @returns {object} Message.
 */
async function closeIncomingConnection(ip, port) {
  if (!ip) return messageHelper.createWarningMessage('To close a connection please provide a proper IP number.');

  const conIndex = incomingConnections.findIndex((peer) => peer.ip === ip && peer.port === port);

  if (conIndex === -1) {
    return messageHelper.createWarningMessage(`Connection from ${ip}:${port} does not exists.`);
  }

  const peerIndex = incomingPeers.findIndex((peer) => peer.ip === ip && peer.port === port);

  if (peerIndex > -1) incomingPeers.splice(peerIndex, 1);

  const wsObj = incomingConnections[conIndex];
  incomingConnections.splice(conIndex, 1);
  wsObj.close(4010, 'purpusfully closed');
  log.info(`Connection from ${ip}:${port} closed with code 4010`);

  return messageHelper.createSuccessMessage(`Incoming connection to ${ip}:${port} closed`);
}

/**
 * To check rate limit.
 * @param {string} ip IP address.
 * @param {number} fillPerSecond Defaults to value of 10.
 * @param {number} maxBurst Defaults to value of 15.
 * @returns {boolean} True if a token is taken from the IP's token bucket. Otherwise false.
 */
function checkRateLimit(ip, fillPerSecond = 10, maxBurst = 15) {
  if (!buckets.has(ip)) {
    buckets.set(ip, new TokenBucket(maxBurst, fillPerSecond));
  }

  const bucketForIP = buckets.get(ip);

  if (bucketForIP.take()) {
    return true;
  }
  return false;
}

/**
 * To get IP addresses for incoming connections.
 * @param {object} req Request.
 * @param {object} res Response.
 */
function getIncomingConnections(req, res) {
  const peers = incomingPeers;
  const connections = peers.map((p) => p.ip);

  const message = messageHelper.createDataMessage(connections);
  response = message;
  res.json(response);
}

/**
 * To get info for incoming connections.
 * @param {object} req Request.
 * @param {object} res Response.
 */
function getIncomingConnectionsInfo(req, res) {
  const connections = incomingPeers;
  const message = messageHelper.createDataMessage(connections);
  response = message;
  return res ? res.json(response) : response;
}

/**
 * Setter for storedFluxBenchAllowed.
 * Main goal for this is testing availability.
 *
 * @param {number} value
 */
function setStoredFluxBenchAllowed(value) {
  storedFluxBenchAllowed = value;
}

/**
 * Getter for storedFluxBenchAllowed.
 * Main goal for this is testing availability.
 *
 * @returns {number} storedFluxBenchAllowed
 */
function getStoredFluxBenchAllowed() {
  return storedFluxBenchAllowed;
}

/**
 * To check if Flux benchmark version is allowed.
 * @returns {boolean} True if version is verified as allowed. Otherwise false.
 */
async function checkFluxbenchVersionAllowed() {
  if (storedFluxBenchAllowed) {
    const versionOK = serviceHelper.minVersionSatisfy(storedFluxBenchAllowed, config.minimumFluxBenchAllowedVersion);
    return versionOK;
  }
  try {
    const benchmarkInfoResponse = await benchmarkService.getInfo();
    if (benchmarkInfoResponse.status === 'success') {
      log.info(benchmarkInfoResponse);
      const benchmarkVersion = benchmarkInfoResponse.data.version;
      setStoredFluxBenchAllowed(benchmarkVersion);
      const versionOK = serviceHelper.minVersionSatisfy(benchmarkVersion, config.minimumFluxBenchAllowedVersion);
      if (versionOK) {
        return true;
      }
      dosState += 11;
      setDosMessage(`Fluxbench Version Error. Current lower version allowed is v${config.minimumFluxBenchAllowedVersion} found v${benchmarkVersion}`);
      log.error(dosMessage);
      return false;
    }
    dosState += 2;
    setDosMessage('Fluxbench Version Error. Error obtaining FluxBench Version.');
    log.error(dosMessage);
    return false;
  } catch (err) {
    log.error(err);
    log.error(`Error on checkFluxBenchVersion: ${err.message}`);
    dosState += 2;
    setDosMessage('Fluxbench Version Error. Error obtaining Flux Version.');
    return false;
  }
}

/**
 * To get node uptime in seconds
 * @param {object} req Request.
 * @param {object} res Response.
 */
function fluxUptime(req, res) {
  let message;
  try {
    const ut = process.uptime();
    const measureUptime = Math.floor(ut);
    message = messageHelper.createDataMessage(measureUptime);
    return res ? res.json(message) : message;
  } catch (error) {
    log.error(error);
    message = messageHelper.createErrorMessage('Error obtaining uptime');
    return res ? res.json(message) : message;
  }
}

/**
 * To get system uptime in seconds
 * @param {object} req Request.
 * @param {object} res Response.
 */
function fluxSystemUptime(req, res) {
  let message;
  try {
    const uptime = os.uptime();
    const measureUptime = Math.floor(uptime);
    message = messageHelper.createDataMessage(measureUptime);
    return res ? res.json(message) : message;
  } catch (error) {
    log.error(error);
    message = messageHelper.createErrorMessage('Error obtaining uptime');
    return res ? res.json(message) : message;
  }
}

/**
 * To check if sufficient communication is established. Minimum number of outgoing and incoming peers must be met.
 * @param {object} req Request.
 * @param {object} res Response.
 */
function isCommunicationEstablished(req, res) {
  let message;
  if (outgoingPeers.length < config.fluxapps.minOutgoing) { // easier to establish
    message = messageHelper.createErrorMessage(`Not enough outgoing connections established to Flux network. Minimum required ${config.fluxapps.minOutgoing} found ${outgoingPeers.length}`);
  } else if (incomingPeers.length < config.fluxapps.minIncoming) { // depends on other nodes successfully connecting to my node, todo enforcement
    message = messageHelper.createErrorMessage(`Not enough incoming connections from Flux network. Minimum required ${config.fluxapps.minIncoming} found ${incomingPeers.length}`);
  } else if ([...new Set(outgoingPeers.map((peer) => peer.ip))].length < config.fluxapps.minUniqueIpsOutgoing) { // depends on other nodes successfully connecting to my node, todo enforcement
    message = messageHelper.createErrorMessage(`Not enough outgoing unique ip's connections established to Flux network. Minimum required ${config.fluxapps.minUniqueIpsOutgoing} found ${[...new Set(outgoingPeers.map((peer) => peer.ip))].length}`);
  } else if ([...new Set(incomingPeers.map((peer) => peer.ip))].length < config.fluxapps.minUniqueIpsIncoming) { // depends on other nodes successfully connecting to my node, todo enforcement
    message = messageHelper.createErrorMessage(`Not enough incoming unique ip's connections from Flux network. Minimum required ${config.fluxapps.minUniqueIpsIncoming} found ${[...new Set(incomingPeers.map((peer) => peer.ip))].length}`);
  } else {
    message = messageHelper.createSuccessMessage('Communication to Flux network is properly established');
  }
  return res ? res.json(message) : message;
}

/**
 * To check ip changes limit. If over limit all apps are uninstalled from the node and it get dos state
 * @returns {boolean} True if a ip as changes more than one time in the last 20h
 */
async function ipChangesOverLimit() {
  const currentTime = Date.now();
  if (ipChangeData) {
    const oldTime = ipChangeData.time;
    const timeDifference = currentTime - oldTime;
    if (timeDifference <= 20 * 60 * 60 * 1000) {
      ipChangeData.count += 1;
      if (ipChangeData.count > maxNumberOfIpChanges) {
        maxNumberOfIpChanges = ipChangeData.count;
      }
      if (ipChangeData.count >= 2) {
        // eslint-disable-next-line global-require
        const appsService = require('./appsService');
        let apps = await appsService.installedApps();
        if (apps.status === 'success' && apps.data.length > 0) {
          apps = apps.data;
          // eslint-disable-next-line no-restricted-syntax
          for (const app of apps) {
            // eslint-disable-next-line no-await-in-loop
            await appsService.removeAppLocally(app.name, null, true, null, false).catch((error) => log.error(error)); // we will not send appremove messages because they will not be accepted by the other nodes
            // eslint-disable-next-line no-await-in-loop
            await serviceHelper.delay(500);
          }
        }
        dosTooManyIpChanges = true;
        return true;
      }
    } else {
      ipChangeData.time = currentTime;
      ipChangeData.count = 1;
      maxNumberOfIpChanges = 1;
    }
    return false;
  }
  ipChangeData = {
    time: currentTime,
    count: 1,
  };
  return false;
}

function getMaxNumberOfIpChanges() {
  return maxNumberOfIpChanges;
}

/**
 * To check user's FluxNode availability.
 * @param {number} retryNumber Number of retries.
 * @returns {boolean} True if all checks passed.
 */
async function checkMyFluxAvailability(retryNumber = 0) {
  if (dosTooManyIpChanges) {
    dosState += 11;
    setDosMessage('IP changes over the limit allowed, one in 20 hours');
    return false;
  }
  let userBlockedPorts = userconfig.initial.blockedPorts || [];
  userBlockedPorts = serviceHelper.ensureObject(userBlockedPorts);
  if (Array.isArray(userBlockedPorts)) {
    if (userBlockedPorts.length > 100) {
      dosState += 11;
      setDosMessage('User blocked ports above 100 limit');
      return false;
    }
  }
  let userBlockedRepositories = userconfig.initial.blockedRepositories || [];
  userBlockedRepositories = serviceHelper.ensureObject(userBlockedRepositories);
  if (Array.isArray(userBlockedRepositories)) {
    if (userBlockedRepositories.length > 10) {
      dosState += 11;
      setDosMessage('User blocked repositories above 10 limit');
      return false;
    }
  }
  const fluxBenchVersionAllowed = await checkFluxbenchVersionAllowed();
  if (!fluxBenchVersionAllowed) {
    return false;
  }
  let askingIP = await getRandomConnection();
  if (typeof askingIP !== 'string' || typeof myFluxIP !== 'string' || myFluxIP === askingIP) {
    return false;
  }
  let askingIpPort = config.server.apiport;
  if (askingIP.includes(':')) { // has port specification
    // it has port specification
    const splittedIP = askingIP.split(':');
    askingIP = splittedIP[0];
    askingIpPort = splittedIP[1];
  }
  let myIP = myFluxIP;
  const oldIP = myFluxIP;
  if (myIP.includes(':')) { // has port specification
    myIP = myIP.split(':')[0];
  }
  let availabilityError = null;
  const axiosConfigAux = {
    timeout: 7000,
  };
  const apiPort = userconfig.initial.apiport || config.server.apiport;
  const resMyAvailability = await serviceHelper.axiosGet(`http://${askingIP}:${askingIpPort}/flux/checkfluxavailability?ip=${myIP}&port=${apiPort}`, axiosConfigAux).catch((error) => {
    log.error(`${askingIP} is not reachable`);
    log.error(error);
    availabilityError = true;
  });
  if (!resMyAvailability || availabilityError) {
    dosState += 2;
    if (dosState > 10) {
      setDosMessage(dosMessage || 'Flux communication is limited, other nodes on the network cannot reach yours through API calls');
      log.error(dosMessage);
      return false;
    }
    if (retryNumber <= 6) {
      const newRetryIndex = retryNumber + 1;
      return checkMyFluxAvailability(newRetryIndex);
    }
    return false;
  }
  if (resMyAvailability.data.status === 'error' || resMyAvailability.data.data.message.includes('not')) {
    log.error(`My Flux unavailability detected from ${askingIP}`);
    // Asked Flux cannot reach me lets check if ip changed
    if (retryNumber === 4 || dosState > 10) {
      log.info('Getting publicIp from FluxBench');
      const benchIpResponse = await benchmarkService.getPublicIp();
      if (benchIpResponse.status === 'success') {
        const benchMyIP = benchIpResponse.data.length > 5 ? benchIpResponse.data : null;
        if (benchMyIP && benchMyIP.split(':')[0] !== myIP.split(':')[0]) {
          await serviceHelper.delay(2 * 1000); // await two seconds
          const newIP = await getMyFluxIPandPort(); // to update node Ip on FluxOs;
          if (newIP && newIP !== oldIP) { // double check
            log.info('FluxBench reported a new IP');
            if (await ipChangesOverLimit()) {
              dosState += 11;
              setDosMessage('IP changes over the limit allowed, one in 20 hours');
              log.error(dosMessage);
            }
            return true;
          }
        } if (benchMyIP && benchMyIP.split(':')[0] === myIP.split(':')[0]) {
          log.info('FluxBench reported the same Ip that was already in use');
        } else {
          setDosMessage('Error getting publicIp from FluxBench');
          dosState += 15;
          log.error('FluxBench wasnt able to detect flux node public ip');
        }
      } else {
        setDosMessage('Error getting publicIp from FluxBench');
        dosState += 15;
        log.error(dosMessage);
        return false;
      }
    }
    dosState += 2;
    if (dosState > 10) {
      setDosMessage(dosMessage || 'Flux is not available for outside communication');
      log.error(dosMessage);
      return false;
    }
    if (retryNumber <= 6) {
      const newRetryIndex = retryNumber + 1;
      return checkMyFluxAvailability(newRetryIndex);
    }
    return false;
  }
  const measuredUptime = fluxUptime();
  if (measuredUptime.status === 'success' && measuredUptime.data > config.fluxapps.minUpTime) { // node has been running for 30 minutes. Upon starting a node, there can be dos that needs resetting
    const nodeList = await fluxCommunicationUtils.deterministicFluxList();
    // nodeList must include our fluxnode ip myIP
    let myCorrectIp = `${myIP}:${apiPort}`;
    if (apiPort === 16127 || apiPort === '16127') {
      myCorrectIp = myCorrectIp.split(':')[0];
    }
    const myNodeExists = nodeList.find((node) => node.ip === myCorrectIp);
    if (nodeList.length > config.fluxapps.minIncoming + config.fluxapps.minOutgoing && myNodeExists) { // our node MUST be in confirmed list in order to have some peers
      // check sufficient connections
      const connectionInfo = isCommunicationEstablished();
      if (connectionInfo.status === 'error') {
        dosState += 0.13; // slow increment, DOS after ~75 minutes. 0.13 per minute. This check depends on other nodes being able to connect to my node
        if (dosState > 10) {
          setDosMessage(connectionInfo.data.message || 'Flux does not have sufficient peers');
          log.error(dosMessage);
          return false;
        }
        return true; // availability ok
      }
    }
  } else if (measuredUptime.status === 'error') {
    log.error('Flux uptime is not available'); // introduce dos increment
  }
  dosState = 0;
  setDosMessage(null);
  return true;
}

/**
 * To adjust an external IP.
 * @param {string} ip IP address.
 * @returns {void} Return statement is only used here to interrupt the function and nothing is returned.
 */
async function adjustExternalIP(ip) {
  try {
    const fluxDirPath = path.join(__dirname, '../../../config/userconfig.js');
    // https://github.com/sindresorhus/ip-regex/blob/master/index.js#L8
    const v4 = '(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]\\d|\\d)(?:\\.(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]\\d|\\d)){3}';
    const v4exact = new RegExp(`^${v4}$`);
    if (!v4exact.test(ip)) {
      log.warn(`Gathered IP ${ip} is not a valid format`);
      return;
    }
    if (ip === userconfig.initial.ipaddress) {
      return;
    }
    const oldUserConfigIp = userconfig.initial.ipaddress;
    log.info(`Adjusting External IP from ${userconfig.initial.ipaddress} to ${ip}`);
    const dataToWrite = `module.exports = {
  initial: {
    ipaddress: '${ip}',
    zelid: '${userconfig.initial.zelid || config.fluxTeamFluxID}',
    kadena: '${userconfig.initial.kadena || ''}',
    testnet: ${userconfig.initial.testnet || false},
    development: ${userconfig.initial.development || false},
    apiport: ${Number(userconfig.initial.apiport || config.server.apiport)},
    routerIP: '${userconfig.initial.routerIP || ''}',
    pgpPrivateKey: \`${userconfig.initial.pgpPrivateKey || ''}\`,
    pgpPublicKey: \`${userconfig.initial.pgpPublicKey || ''}\`,
    blockedPorts: [${userconfig.initial.blockedPorts || ''}],
    blockedRepositories: ${JSON.stringify(userconfig.initial.blockedRepositories || []).replace(/"/g, "'")},
  }
}`;

    await fs.writeFile(fluxDirPath, dataToWrite);

    if (oldUserConfigIp && v4exact.test(oldUserConfigIp) && !myCache.has(ip)) {
      myCache.set(ip, ip);
      const newIP = userconfig.initial.apiport !== 16127 ? `${ip}:${userconfig.initial.apiport}` : ip;
      const oldIP = userconfig.initial.apiport !== 16127 ? `${oldUserConfigIp}:${userconfig.initial.apiport}` : oldUserConfigIp;
      log.info(`New public Ip detected: ${newIP}, old Ip:${oldIP} , updating the FluxNode info in the network`);
      // eslint-disable-next-line global-require
      const appsService = require('./appsService');
      let apps = await appsService.installedApps();
      if (apps.status === 'success' && apps.data.length > 0) {
        apps = apps.data;
        let appsRemoved = 0;
        // eslint-disable-next-line no-restricted-syntax
        for (const app of apps) {
          // eslint-disable-next-line no-await-in-loop
          const runningAppList = await appsService.getRunningAppList(app.name);
          const findMyIP = runningAppList.find((instance) => instance.ip.split(':')[0] === ip);
          if (findMyIP) {
            log.info(`Aplication: ${app.name}, was found on the network already running under the same ip, uninstalling app`);
            // eslint-disable-next-line no-await-in-loop
            await appsService.removeAppLocally(app.name, null, true, null, true).catch((error) => log.error(error));
            appsRemoved += 1;
          }
        }
        if (apps.length > appsRemoved) {
          const broadcastedAt = Date.now();
          const newIpChangedMessage = {
            type: 'fluxipchanged',
            version: 1,
            oldIP,
            newIP,
            broadcastedAt,
          };
          // broadcast messages about ip changed to all peers
          // eslint-disable-next-line global-require
          const fluxCommunicationMessagesSender = require('./fluxCommunicationMessagesSender');
          await fluxCommunicationMessagesSender.broadcastMessageToOutgoing(newIpChangedMessage);
          await serviceHelper.delay(500);
          await fluxCommunicationMessagesSender.broadcastMessageToIncoming(newIpChangedMessage);
        }
      }
      const result = await daemonServiceWalletRpcs.createConfirmationTransaction();
      log.info(`createConfirmationTransaction: ${JSON.stringify(result)}`);
    }
  } catch (error) {
    log.error(error);
  }
}

/**
 * To check deterministic node collisions (i.e. if multiple FluxNode instances detected).
 * @returns {void} Return statement is only used here to interrupt the function and nothing is returned.
 */
async function checkDeterministicNodesCollisions() {
  try {
    // get my external ip address
    // get node list with filter on this ip address
    // if it returns more than 1 object, shut down.
    // another precatuion might be comparing node list on multiple nodes. evaulate in the future
    const myIP = await getMyFluxIPandPort();
    if (myIP) {
      const syncStatus = daemonServiceMiscRpcs.isDaemonSynced();
      if (!syncStatus.data.synced) {
        setTimeout(() => {
          checkDeterministicNodesCollisions();
        }, 120 * 1000);
        return;
      }
      const nodeList = await fluxCommunicationUtils.deterministicFluxList();
      const result = nodeList.filter((node) => node.ip === myIP);
      const nodeStatus = await daemonServiceFluxnodeRpcs.getFluxNodeStatus();
      if (nodeStatus.status === 'success') { // different scenario is caught elsewhere
        const myCollateral = nodeStatus.data.collateral;
        const myNode = result.find((node) => node.collateral === myCollateral);
        const nodeCollateralDifferentIp = nodeList.find((node) => node.collateral === myCollateral && node.ip !== myIP);
        if (result.length > 1) {
          log.warn('Multiple Flux Node instances detected');
          if (myNode) {
            const myBlockHeight = myNode.readded_confirmed_height || myNode.confirmed_height; // todo we may want to introduce new readded heights and readded confirmations
            const filterEarlierSame = result.filter((node) => (node.readded_confirmed_height || node.confirmed_height) <= myBlockHeight);
            // keep running only older collaterals
            if (filterEarlierSame.length >= 1) {
              log.error(`Flux earlier collision detection on ip:${myIP}`);
              dosState = 100;
              setDosMessage(`Flux earlier collision detection on ip:${myIP}`);
              setTimeout(() => {
                checkDeterministicNodesCollisions();
              }, 60 * 1000);
              return;
            }
          }
          // prevent new activation
        } else if (result.length === 1) {
          if (!myNode) {
            log.error('Flux collision detection. Another ip:port is confirmed on flux network with the same collateral transaction information.');
            dosState = 100;
            setDosMessage('Flux collision detection. Another ip:port is confirmed on flux network with the same collateral transaction information.');
            setTimeout(() => {
              checkDeterministicNodesCollisions();
            }, 60 * 1000);
            return;
          }
        } else if (nodeStatus.data.status === 'CONFIRMED' && nodeCollateralDifferentIp) {
          let errorCall = false;
          const askingIP = nodeCollateralDifferentIp.ip.split(':')[0];
          const askingIpPort = nodeCollateralDifferentIp.ip.split(':')[1] || '16127';
          await serviceHelper.axiosGet(`http://${askingIP}:${askingIpPort}/flux/version`, axiosConfig).catch(errorCall = true);
          if (!errorCall) {
            log.error('Flux collision detection. Another ip:port is confirmed and reachable on flux network with the same collateral transaction information.');
            dosState = 100;
            setDosMessage('Flux collision detection. Another ip:port is confirmed and reachable on flux network with the same collateral transaction information.');
            setTimeout(() => {
              checkDeterministicNodesCollisions();
            }, 60 * 1000);
            return;
          }
          const daemonResult = await daemonServiceWalletRpcs.createConfirmationTransaction();
          log.info(`createConfirmationTransaction: ${JSON.stringify(daemonResult)}`);
        }
      }
      // early stages of the network or testnet
      if (nodeList.length > config.fluxapps.minIncoming + config.fluxapps.minOutgoing) {
        const availabilityOk = await checkMyFluxAvailability();
        if (availabilityOk) {
          await adjustExternalIP(myIP.split(':')[0]);
        }
      } else { // sufficient amount of nodes has to appear on the network within 6 hours
        const measuredUptime = fluxUptime();
        if (measuredUptime.status === 'success' && measuredUptime.data > (config.fluxapps.minUpTime * 12)) {
          const availabilityOk = await checkMyFluxAvailability();
          if (availabilityOk) {
            await adjustExternalIP(myIP.split(':')[0]);
          }
        } else if (measuredUptime.status === 'error') {
          log.error('Flux uptime unavailable');
          const availabilityOk = await checkMyFluxAvailability();
          if (availabilityOk) {
            await adjustExternalIP(myIP.split(':')[0]);
          }
        }
      }
    } else {
      dosState += 1;
      if (dosState > 10) {
        setDosMessage(dosMessage || 'Flux IP detection failed');
        log.error(dosMessage);
      }
    }
    setTimeout(() => {
      checkDeterministicNodesCollisions();
    }, 60 * 1000);
  } catch (error) {
    log.error(error);
    setTimeout(() => {
      checkDeterministicNodesCollisions();
    }, 120 * 1000);
  }
}

/**
 * To get DOS state.
 * @param {object} req Request.
 * @param {object} res Response.
 * @returns {object} Message.
 */
function getDOSState(req, res) {
  const data = {
    dosState,
    dosMessage,
  };
  response = messageHelper.createDataMessage(data);
  return res ? res.json(response) : response;
}

/**
 * To allow a port.
 * @param {string} port Port.
 * @returns {object} Command status.
 */
async function allowPort(port) {
  const cmdAsync = util.promisify(nodecmd.get);
  const cmdStat = {
    status: false,
    message: null,
  };
  if (Number.isNaN(+port)) {
    cmdStat.message = 'Port needs to be a number';
    return cmdStat;
  }
  const exec = `LANG="en_US.UTF-8" && sudo ufw allow ${port} && sudo ufw allow out ${port}`;
  const cmdres = await cmdAsync(exec);
  cmdStat.message = cmdres;
  if (serviceHelper.ensureString(cmdres).includes('updated') || serviceHelper.ensureString(cmdres).includes('added')) {
    cmdStat.status = true;
  } else if (serviceHelper.ensureString(cmdres).includes('existing')) {
    cmdStat.status = true;
    cmdStat.message = 'existing';
  } else {
    cmdStat.status = false;
  }
  return cmdStat;
}

/**
 * To allow out a port.
 * @param {string} port Port.
 * @returns {object} Command status.
 */
async function allowOutPort(port) {
  const cmdAsync = util.promisify(nodecmd.get);
  const cmdStat = {
    status: false,
    message: null,
  };
  if (Number.isNaN(+port)) {
    cmdStat.message = 'Port needs to be a number';
    return cmdStat;
  }
  const exec = `LANG="en_US.UTF-8" && sudo ufw allow out ${port}`;
  const cmdres = await cmdAsync(exec);
  cmdStat.message = cmdres;
  if (serviceHelper.ensureString(cmdres).includes('updated') || serviceHelper.ensureString(cmdres).includes('added')) {
    cmdStat.status = true;
  } else if (serviceHelper.ensureString(cmdres).includes('existing')) {
    cmdStat.status = true;
    cmdStat.message = 'existing';
  } else {
    cmdStat.status = false;
  }
  return cmdStat;
}

/**
 * To deny a port.
 * @param {string} port Port.
 * @returns {object} Command status.
 */
async function denyPort(port) {
  const cmdAsync = util.promisify(nodecmd.get);
  const cmdStat = {
    status: false,
    message: null,
  };
  if (Number.isNaN(+port)) {
    cmdStat.message = 'Port needs to be a number';
    return cmdStat;
  }
  const portBanned = isPortBanned(+port);
  if (+port < (config.fluxapps.portMinNew) || +port > config.fluxapps.portMaxNew || portBanned) {
    cmdStat.message = 'Port out of deletable app ports range';
    return cmdStat;
  }
  const exec = `LANG="en_US.UTF-8" && sudo ufw deny ${port} && sudo ufw deny out ${port}`;
  const cmdres = await cmdAsync(exec);
  cmdStat.message = cmdres;
  if (serviceHelper.ensureString(cmdres).includes('updated') || serviceHelper.ensureString(cmdres).includes('added')) {
    cmdStat.status = true;
  } else if (serviceHelper.ensureString(cmdres).includes('existing')) {
    cmdStat.status = true;
    cmdStat.message = 'existing';
  } else {
    cmdStat.status = false;
  }
  return cmdStat;
}

/**
 * To delete a ufw allow rule on port.
 * @param {string} port Port.
 * @returns {object} Command status.
 */
async function deleteAllowPortRule(port) {
  const cmdAsync = util.promisify(nodecmd.get);
  const cmdStat = {
    status: false,
    message: null,
  };
  if (Number.isNaN(+port)) {
    cmdStat.message = 'Port needs to be a number';
    return cmdStat;
  }
  const portBanned = isPortBanned(+port);
  if (+port < (config.fluxapps.portMinNew) || +port > config.fluxapps.portMaxNew || portBanned) {
    cmdStat.message = 'Port out of deletable app ports range';
    return cmdStat;
  }
  const exec = `LANG="en_US.UTF-8" && sudo ufw delete allow ${port} && sudo ufw delete allow out ${port}`;
  const cmdres = await cmdAsync(exec);
  cmdStat.message = cmdres;
  if (serviceHelper.ensureString(cmdres).includes('delete')) { // Rule deleted or Could not delete non-existent rule both ok
    cmdStat.status = true;
  } else {
    cmdStat.status = false;
  }
  return cmdStat;
}

/**
 * To delete a ufw deny rule on port.
 * @param {string} port Port.
 * @returns {object} Command status.
 */
async function deleteDenyPortRule(port) {
  const cmdAsync = util.promisify(nodecmd.get);
  const cmdStat = {
    status: false,
    message: null,
  };
  if (Number.isNaN(+port)) {
    cmdStat.message = 'Port needs to be a number';
    return cmdStat;
  }
  const portBanned = isPortBanned(+port);
  if (+port < (config.fluxapps.portMinNew) || +port > config.fluxapps.portMaxNew || portBanned) {
    cmdStat.message = 'Port out of deletable app ports range';
    return cmdStat;
  }
  const exec = `LANG="en_US.UTF-8" && sudo ufw delete deny ${port} && sudo ufw delete deny out ${port}`;
  const cmdres = await cmdAsync(exec);
  cmdStat.message = cmdres;
  if (serviceHelper.ensureString(cmdres).includes('delete')) { // Rule deleted or Could not delete non-existent rule both ok
    cmdStat.status = true;
  } else {
    cmdStat.status = false;
  }
  return cmdStat;
}

/**
 * To delete a ufw allow rule on port.
 * @param {string} port Port.
 * @returns {object} Command status.
 */
async function deleteAllowOutPortRule(port) {
  const cmdAsync = util.promisify(nodecmd.get);
  const cmdStat = {
    status: false,
    message: null,
  };
  if (Number.isNaN(+port)) {
    cmdStat.message = 'Port needs to be a number';
    return cmdStat;
  }
  const portBanned = isPortBanned(+port);
  if (+port < (config.fluxapps.portMinNew) || +port > config.fluxapps.portMaxNew || portBanned) {
    cmdStat.message = 'Port out of deletable app ports range';
    return cmdStat;
  }
  const exec = `LANG="en_US.UTF-8" && sudo ufw delete allow out ${port}`;
  const cmdres = await cmdAsync(exec);
  cmdStat.message = cmdres;
  if (serviceHelper.ensureString(cmdres).includes('delete')) { // Rule deleted or Could not delete non-existent rule both ok
    cmdStat.status = true;
  } else {
    cmdStat.status = false;
  }
  return cmdStat;
}

/**
 * To allow a port via API. Only accessible by admins and Flux team members.
 * @param {object} req Request.
 * @param {object} res Response.
 * @returns {object} Message.
 */
async function allowPortApi(req, res) {
  let { port } = req.params;
  port = port || req.query.port;
  if (port === undefined || port === null) {
    const errMessage = messageHelper.createErrorMessage('No Port address specified.');
    return res.json(errMessage);
  }
  const authorized = await verificationHelper.verifyPrivilege('adminandfluxteam', req);

  if (authorized === true) {
    const portResponseOK = await allowPort(port);
    if (portResponseOK.status === true) {
      response = messageHelper.createSuccessMessage(portResponseOK.message, port, port);
    } else if (portResponseOK.status === false) {
      response = messageHelper.createErrorMessage(portResponseOK.message, port, port);
    } else {
      response = messageHelper.createErrorMessage(`Unknown error while opening port ${port}`);
    }
  } else {
    response = messageHelper.errUnauthorizedMessage();
  }
  return res.json(response);
}

/**
 * To check if a firewall is active.
 * @returns {boolean} True if a firewall is active. Otherwise false.
 */
async function isFirewallActive() {
  try {
    const cmdAsync = util.promisify(nodecmd.get);
    const execA = 'LANG="en_US.UTF-8" && sudo ufw status | grep Status';
    const cmdresA = await cmdAsync(execA);
    if (serviceHelper.ensureString(cmdresA).includes('Status: active')) {
      return true;
    }
    return false;
  } catch (error) {
    // command ufw not found is the most likely reason
    log.error(error);
    return false;
  }
}

/**
 * To adjust a firewall to allow ports for Flux.
 */
async function adjustFirewall() {
  try {
    const cmdAsync = util.promisify(nodecmd.get);
    const apiPort = userconfig.initial.apiport || config.server.apiport;
    const homePort = +apiPort - 1;
    const apiSSLPort = +apiPort + 1;
    const syncthingPort = +apiPort + 2;
    let ports = [apiPort, homePort, apiSSLPort, syncthingPort, 80, 443, 16125];
    const fluxCommunicationPorts = config.server.allowedPorts;
    ports = ports.concat(fluxCommunicationPorts);
    const firewallActive = await isFirewallActive();
    if (firewallActive) {
      // set default allow outgoing
      const execAllowA = 'LANG="en_US.UTF-8" && sudo ufw default allow outgoing';
      await cmdAsync(execAllowA);
      // allow speedtests
      const execAllowB = 'LANG="en_US.UTF-8" && sudo ufw insert 1 allow out 5060';
      const execAllowC = 'LANG="en_US.UTF-8" && sudo ufw insert 1 allow out 8080';
      await cmdAsync(execAllowB);
      await cmdAsync(execAllowC);
      // allow incoming and outgoing DNS traffic
      const execAllowD = 'LANG="en_US.UTF-8" && sudo ufw insert 1 allow in proto udp to any port 53';
      const execAllowE = 'LANG="en_US.UTF-8" && sudo ufw insert 1 allow out proto udp to any port 53';
      const execAllowF = 'LANG="en_US.UTF-8" && sudo ufw insert 1 allow out proto tcp to any port 53';
      await cmdAsync(execAllowD);
      await cmdAsync(execAllowE);
      await cmdAsync(execAllowF);
      log.info('Firewall adjusted for DNS traffic');

      const commandGetRouterIP = 'ip rout | head -n1 | awk \'{print $3}\'';
      let routerIP = await cmdAsync(commandGetRouterIP);
      routerIP = routerIP.replace(/(\r\n|\n|\r)/gm, '');
      log.info(`Router IP: ${routerIP}`);
      if (serviceHelper.validIpv4Address(routerIP)
        && (routerIP.startsWith('192.168.') || routerIP.startsWith('10.') || routerIP.startsWith('172.16.')
       || routerIP.startsWith('100.64.') || routerIP.startsWith('198.18.') || routerIP.startsWith('169.254.'))) {
        const execRouterAllowA = `LANG="en_US.UTF-8" && sudo ufw insert 1 allow out from any to ${routerIP} proto tcp > /dev/null 2>&1`;
        const execRouterAllowB = `LANG="en_US.UTF-8" && sudo ufw insert 1 allow from ${routerIP} to any proto udp > /dev/null 2>&1`;
        await cmdAsync(execRouterAllowA);
        await cmdAsync(execRouterAllowB);
        log.info(`Firewall adjusted for comms with router on local ip ${routerIP}`);
      }
      // eslint-disable-next-line no-restricted-syntax
      for (const port of ports) {
        const execB = `LANG="en_US.UTF-8" && sudo ufw allow ${port}`;
        const execC = `LANG="en_US.UTF-8" && sudo ufw allow out ${port}`;

        // eslint-disable-next-line no-await-in-loop
        const cmdresB = await cmdAsync(execB);
        if (serviceHelper.ensureString(cmdresB).includes('updated') || serviceHelper.ensureString(cmdresB).includes('existing') || serviceHelper.ensureString(cmdresB).includes('added')) {
          log.info(`Firewall adjusted for port ${port}`);
        } else {
          log.info(`Failed to adjust Firewall for port ${port}`);
        }

        // eslint-disable-next-line no-await-in-loop
        const cmdresC = await cmdAsync(execC);
        if (serviceHelper.ensureString(cmdresC).includes('updated') || serviceHelper.ensureString(cmdresC).includes('existing') || serviceHelper.ensureString(cmdresC).includes('added')) {
          log.info(`Firewall out adjusted for port ${port}`);
        } else {
          log.info(`Failed to adjust Firewall out for port ${port}`);
        }
      }
    } else {
      log.info('Firewall is not active. Adjusting not applied');
    }
  } catch (error) {
    log.error(error);
  }
}

/**
 * To clean a firewall deny policies, and delete them from it.
 */
async function purgeUFW() {
  try {
    const cmdAsync = util.promisify(nodecmd.get);
    const firewallActive = await isFirewallActive();
    if (firewallActive) {
      const execB = 'LANG="en_US.UTF-8" && sudo ufw status | grep \'DENY\' | grep -E \'(3[0-9]{4})\''; // 30000 - 39999
      const cmdresB = await cmdAsync(execB).catch(() => { }) || ''; // fail silently,
      if (serviceHelper.ensureString(cmdresB).includes('DENY')) {
        const deniedPorts = cmdresB.split('\n'); // split by new line
        const portsToDelete = [];
        deniedPorts.forEach((port) => {
          const adjPort = port.substring(0, port.indexOf(' '));
          if (adjPort) { // last line is empty
            if (!portsToDelete.includes(adjPort)) {
              portsToDelete.push(adjPort);
            }
          }
        });
        // eslint-disable-next-line no-restricted-syntax
        for (const port of portsToDelete) {
          // eslint-disable-next-line no-await-in-loop
          await deleteDenyPortRule(port);
        }
        log.info('UFW app deny rules on ports purged');
      } else {
        log.info('No UFW deny on ports rules found');
      }
      const execDelDenyA = 'LANG="en_US.UTF-8" && sudo ufw delete deny out from any to 10.0.0.0/8';
      const execDelDenyB = 'LANG="en_US.UTF-8" && sudo ufw delete deny out from any to 172.16.0.0/12';
      const execDelDenyC = 'LANG="en_US.UTF-8" && sudo ufw delete deny out from any to 192.168.0.0/16';
      const execDelDenyD = 'LANG="en_US.UTF-8" && sudo ufw delete deny out from any to 100.64.0.0/10';
      const execDelDenyE = 'LANG="en_US.UTF-8" && sudo ufw delete deny out from any to 198.18.0.0/15';
      const execDelDenyF = 'LANG="en_US.UTF-8" && sudo ufw delete deny out from any to 169.254.0.0/16';
      await cmdAsync(execDelDenyA);
      await cmdAsync(execDelDenyB);
      await cmdAsync(execDelDenyC);
      await cmdAsync(execDelDenyD);
      await cmdAsync(execDelDenyE);
      await cmdAsync(execDelDenyF);
      log.info('UFW app deny netscans rules purged');
    } else {
      log.info('Firewall is not active. Purging UFW not necessary');
    }
  } catch (error) {
    log.error(error);
  }
}

/**
 * This fix a docker security issue where docker containers can access private node operator networks, for example to create port forwarding on hosts.
 *
 * Docker should create a DOCKER-USER chain. If this doesn't exist - we create it, then jump to this chain immediately from the FORWARD CHAIN.
 * This allows rules to be added via -I (insert) and -A (append) to the DOCKER-USER chain individually, so we can ALWAYS append the
 * drop traffic rule, and insert the ACCEPT rules. If no matches are found in the DOCKER-USER chain, rule evaluation continues
 * from the next rule in the FORWARD chain.
 *
 * If needed in the future, we can actually create a JUMP from the DOCKER-USER chain to a custom chain. The reason why we MUST use the DOCKER-USER
 * chain is that whenever docker creates a new network, it re-jumps the DOCKER-USER chain at the head of the FORWARD chain.
 *
 * As can be seen in this example:
 *
 * Originally, was using the FLUX chain, but you can see docker inserted the br-72d1725e481c network ahead, as well as the JUMP to DOCKER-USER,
 * which invalidates any rules in the FLUX chain, as there is basically an accept any:
 *
 * FORWARD -i br-72d1725e481c ! -o br-72d1725e481c -j ACCEPT
 *
 * ```bash
 * -A INPUT -j ufw-track-input
 * -A FORWARD -j DOCKER-USER
 * -A FORWARD -j DOCKER-ISOLATION-STAGE-1
 * -A FORWARD -o br-72d1725e481c -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT
 * -A FORWARD -o br-72d1725e481c -j DOCKER
 * -A FORWARD -i br-72d1725e481c ! -o br-72d1725e481c -j ACCEPT
 * -A FORWARD -i br-72d1725e481c -o br-72d1725e481c -j ACCEPT
 * -A FORWARD -j FLUX
 * -A FORWARD -o br-048fde111132 -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT
 * -A FORWARD -o br-048fde111132 -j DOCKER
 * -A FORWARD -i br-048fde111132 ! -o br-048fde111132 -j ACCEPT
 * -A FORWARD -i br-048fde111132 -o br-048fde111132 -j ACCEPT
 *```
 * This means if a user or someone was to delete a single rule, we are able to recover correctly from it.
 *
 * The other option - is just to Flush all rules on every run, and reset them all. This is what we are doing now.
 *
 * @param {string[]} fluxNetworkInterfaces The network interfaces, br-<12 character string>
 * @returns  {Promise<Boolean>}
 */
async function removeDockerContainerAccessToNonRoutable(fluxNetworkInterfaces) {
  const cmdAsync = util.promisify(nodecmd.get);

  const checkIptables = 'sudo iptables --version';
  const iptablesInstalled = await cmdAsync(checkIptables).catch(() => {
    log.error('Unable to find iptables binary');
    return false;
  });

  if (!iptablesInstalled) return false;

  // check if rules have been created, as iptables is NOT idempotent.
  const checkDockerUserChain = 'sudo iptables -L DOCKER-USER';
  // iptables 1.8.4 doesn't return anything - so have updated command a little
  const checkJumpChain = 'sudo iptables -C FORWARD -j DOCKER-USER && echo true';

  const dockerUserChainExists = await cmdAsync(checkDockerUserChain).catch(async () => {
    try {
      await cmdAsync('sudo iptables -N DOCKER-USER');
      log.info('IPTABLES: DOCKER-USER chain created');
    } catch (err) {
      log.error('IPTABLES: Error adding DOCKER-USER chain');
      // if we can't add chain, we can't proceed
      return new Error();
    }
    return null;
  });

  if (dockerUserChainExists instanceof Error) return false;
  if (dockerUserChainExists) log.info('IPTABLES: DOCKER-USER chain already created');

  const checkJumpToDockerChain = await cmdAsync(checkJumpChain).catch(async () => {
    // Ubuntu 20.04 @ iptables 1.8.4 Error: "iptables: No chain/target/match by that name."
    // Ubuntu 22.04 @ iptables 1.8.7 Error: "iptables: Bad rule (does a matching rule exist in that chain?)."
    const jumpToFluxChain = 'sudo iptables -I FORWARD -j DOCKER-USER';
    try {
      await cmdAsync(jumpToFluxChain);
      log.info('IPTABLES: New rule in FORWARD inserted to jump to DOCKER-USER chain');
    } catch (err) {
      log.error('IPTABLES: Error inserting FORWARD jump to DOCKER-USER chain');
      // if we can't jump, we need to bail out
      return new Error();
    }

    return null;
  });

  if (checkJumpToDockerChain instanceof Error) return false;
  if (checkJumpToDockerChain) log.info('IPTABLES: Jump to DOCKER-USER chain already enabled');

  const rfc1918Networks = ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16'];
  const fluxSrc = '172.23.0.0/16';

  const baseDropCmd = `sudo iptables -A DOCKER-USER -s ${fluxSrc} -d #DST -j DROP`;
  const baseAllowToFluxNetworksCmd = 'sudo iptables -I DOCKER-USER -i #INT -o #INT -j ACCEPT';
  const baseAllowEstablishedCmd = `sudo iptables -I DOCKER-USER -s ${fluxSrc} -d #DST -m state --state RELATED,ESTABLISHED -j ACCEPT`;
  const baseAllowDnsCmd = `sudo iptables -I DOCKER-USER -s ${fluxSrc} -d #DST -p udp --dport 53 -j ACCEPT`;

  const addReturnCmd = 'sudo iptables -A DOCKER-USER -j RETURN';
  const flushDockerUserCmd = 'sudo iptables -F DOCKER-USER';

  try {
    await cmdAsync(flushDockerUserCmd);
    log.info('IPTABLES: DOCKER-USER table flushed');
  } catch (err) {
    log.error(`IPTABLES: Error flushing DOCKER-USER table. ${err}`);
    return false;
  }

  // add for legacy apps
  fluxNetworkInterfaces.push('docker0');

  // eslint-disable-next-line no-restricted-syntax
  for (const int of fluxNetworkInterfaces) {
    // if this errors, we need to bail, as if the deny succeedes, we may cut off access
    const giveFluxNetworkAccess = baseAllowToFluxNetworksCmd.replace(/#INT/g, int);
    try {
      // eslint-disable-next-line no-await-in-loop
      await cmdAsync(giveFluxNetworkAccess);
      log.info(`IPTABLES: Traffic on Flux interface ${int} accepted`);
    } catch (err) {
      log.error(`IPTABLES: Error allowing traffic on Flux interface ${int}. ${err}`);
      return false;
    }
  }

  // eslint-disable-next-line no-restricted-syntax
  for (const network of rfc1918Networks) {
    // if any of these error, we need to bail, as if the deny succeedes, we may cut off access

    const giveHostAccessToDockerNetwork = baseAllowEstablishedCmd.replace('#DST', network);
    try {
      // eslint-disable-next-line no-await-in-loop
      await cmdAsync(giveHostAccessToDockerNetwork);
      log.info(`IPTABLES: Access to Flux containers from ${network} accepted`);
    } catch (err) {
      log.error(`IPTABLES: Error allowing access to Flux containers from ${network}. ${err}`);
      return false;
    }

    const giveContainerAccessToDNS = baseAllowDnsCmd.replace('#DST', network);
    try {
      // eslint-disable-next-line no-await-in-loop
      await cmdAsync(giveContainerAccessToDNS);
      log.info(`IPTABLES: DNS access to ${network} from Flux containers accepted`);
    } catch (err) {
      log.error(`IPTABLES: Error allowing DNS access to ${network} from Flux containers. ${err}`);
      return false;
    }

    // This always gets appended, so the drop is at the end
    const dropAccessToHostNetwork = baseDropCmd.replace('#DST', network);
    try {
      // eslint-disable-next-line no-await-in-loop
      await cmdAsync(dropAccessToHostNetwork);
      log.info(`IPTABLES: Access to ${network} from Flux containers removed`);
    } catch (err) {
      log.error(`IPTABLES: Error denying access to ${network} from Flux containers. ${err}`);
      return false;
    }
  }

  try {
    await cmdAsync(addReturnCmd);
    log.info('IPTABLES: DOCKER-USER explicit return to FORWARD chain added');
  } catch (err) {
    log.error(`IPTABLES: Error adding explicit return to Forward chain. ${err}`);
    return false;
  }
  return true;
}

const lruRateOptions = {
  max: 500,
  ttl: 1000 * 15, // 15 seconds
  maxAge: 1000 * 15, // 15 seconds
};
const lruRateCache = new LRUCache(lruRateOptions);
/**
 * To check rate limit.
 * @param {string} ip IP address.
 * @param {number} limitPerSecond Defaults to value of 20
 * @returns {boolean} True if a ip is allowed to do a request, otherwise false
 */
function lruRateLimit(ip, limitPerSecond = 20) {
  const lruResponse = lruRateCache.get(ip);
  const newTime = Date.now();
  if (lruResponse) {
    const oldTime = lruResponse.time;
    const oldTokensRemaining = lruResponse.tokens;
    const timeDifference = newTime - oldTime;
    const tokensToAdd = (timeDifference / 1000) * limitPerSecond;
    let newTokensRemaining = oldTokensRemaining + tokensToAdd;
    if (newTokensRemaining < 0) {
      const newdata = {
        time: newTime,
        tokens: newTokensRemaining,
      };
      lruRateCache.set(ip, newdata);
      log.warn(`${ip} rate limited`);
      return false;
    }
    if (newTokensRemaining > limitPerSecond) {
      newTokensRemaining = limitPerSecond;
      newTokensRemaining -= 1;
      const newdata = {
        time: newTime,
        tokens: newTokensRemaining,
      };
      lruRateCache.set(ip, newdata);
      return true;
    }
    newTokensRemaining -= 1;
    const newdata = {
      time: newTime,
      tokens: newTokensRemaining,
    };
    lruRateCache.set(ip, newdata);
    return true;
  }
  const newdata = {
    time: newTime,
    tokens: limitPerSecond,
  };
  lruRateCache.set(ip, newdata);
  return true;
}

/**
 * Allow Node to bind to privileged without sudo
 */
async function allowNodeToBindPrivilegedPorts() {
  try {
    const cmdAsync = util.promisify(nodecmd.get);
    const exec = "sudo setcap 'cap_net_bind_service=+ep' `which node`";
    await cmdAsync(exec);
  } catch (error) {
    log.error(error);
  }
}

module.exports = {
  isFluxAvailable,
  checkFluxAvailability,
  getMyFluxIPandPort,
  getRandomConnection,
  getFluxNodePrivateKey,
  getFluxNodePublicKey,
  checkDeterministicNodesCollisions,
  getIncomingConnections,
  getIncomingConnectionsInfo,
  getDOSState,
  denyPort,
  deleteAllowPortRule,
  deleteAllowOutPortRule,
  allowPortApi,
  adjustFirewall,
  purgeUFW,
  checkRateLimit,
  closeConnection,
  closeIncomingConnection,
  checkFluxbenchVersionAllowed,
  checkMyFluxAvailability,
  adjustExternalIP,
  allowPort,
  allowOutPort,
  isFirewallActive,
  // Exports for testing purposes
  setStoredFluxBenchAllowed,
  getStoredFluxBenchAllowed,
  setMyFluxIp,
  getDosMessage,
  setDosMessage,
  setDosStateValue,
  getDosStateValue,
  fluxUptime,
  fluxSystemUptime,
  isCommunicationEstablished,
  lruRateLimit,
  isPortOpen,
  checkAppAvailability,
  isPortEnterprise,
  isPortBanned,
  isPortUPNPBanned,
  isPortUserBlocked,
  allowNodeToBindPrivilegedPorts,
  removeDockerContainerAccessToNonRoutable,
  getMaxNumberOfIpChanges,
};
