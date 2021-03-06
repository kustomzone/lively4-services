var childProcess = require('child_process');
var spawn = childProcess.spawn;
var rimraf = require('rimraf');
var config = require('./config');
var services = {};
var debugServerChild = null;
var promisify = require('promisify-node');
var fs = promisify('fs');
var _ = require('lodash');
var forever = require('forever-monitor');
var unusedDebugPort = 5000;
var serviceIDs = 0;

function createDir(dir) {
  return fs.mkdir(dir).catch(function(err) {
    if (err && err.code === 'EEXIST') {
      return;
    }
    throw new Error(err);
  });
}

var ServiceManager = {
  serviceExists: function(serviceID) {
    return serviceID in services;
  },
  getServiceWithoutChild: function(service) {
    return _.omit(service, ['child']);
  },
  listProcesses: function() {
    return _.mapValues(services, this.getServiceWithoutChild);
  },
  getProcessInfo: function(serviceID) {
    if (!this.serviceExists(serviceID)) {
      return Promise.reject('Service #' + serviceID + ' does not exist.');
    }
    return Promise.all([
      fs.readFile(config.logsDir + '/' + serviceID + '/stdout.log', 'utf8'),
      fs.readFile(config.logsDir + '/' + serviceID + '/stderr.log', 'utf8')
    ]).then(function(logs) {
      return {
        service: this.getServiceWithoutChild(services[serviceID]),
        stdout: logs[0],
        stderr: logs[1]
      };
    }.bind(this));
  },
  addService: function(entryPoint) {
    if (!fs.existsSync(config.servicesDir + '/' + entryPoint)) {
      return Promise.reject("Entry point doesn't exist: " + entryPoint);
    }
    var serviceID = serviceIDs++;
    services[serviceID] = {
      id: serviceID,
      status: 0,
      start: -1,
      kill: -1,
      child: null,
      debugPort: null,
      entryPoint: entryPoint
    };
    return createDir(config.logsDir).then(function() {
      return createDir(config.logsDir + '/' + serviceID);
    }).then(function() {
      return serviceID;
    });
  },
  getFilepath: function(serviceID) {
    return config.servicesDir + '/' + serviceID + '/index.js';
  },
  spawnProcess: function(serviceID) {
    if (!this.serviceExists(serviceID)) {
      throw new Error('Service #' + serviceID + ' not found.');
    }

    var service = services[serviceID];
    var serviceFile =  config.servicesDir + '/' + service.entryPoint;
    var stdoutFile = config.logsDir + '/' + serviceID + '/stdout.log';
    var stderrFile = config.logsDir + '/' + serviceID + '/stderr.log';
    fs.writeFile(stdoutFile, '');
    fs.writeFile(stderrFile, '');
    var debugPort = unusedDebugPort++;
    var child = spawn('node', ['--debug=' + debugPort, serviceFile]);


    service.start = new Date().getTime();
    service.status = 1;
    service.child = child;
    service.debugPort = debugPort;

    services[serviceID] = service;

    child.stdout.on('data', function (data) {
      fs.appendFile(stdoutFile, data.toString());
      console.log(child.pid, data.toString());
    });

    child.stderr.on('data', function (data) {
      fs.appendFile(stderrFile, data.toString());
      console.log(child.pid, data.toString());
    });

    child.on('close', function(exitCode) {
      var runningService = services[serviceID];
      if (runningService) {
        runningService.status = 0;
        runningService.kill = new Date().getTime();
      }

      console.log('Closed before stop: Closing code: ', exitCode);
    });
  },
  killProcess: function(serviceID) {
    var runningService = services[serviceID];
    if (runningService) {
      console.log('kill process');
      runningService.child.kill('SIGKILL');
      runningService.status = 0;
      runningService.kill = new Date().getTime();
    }
  },
  removeProcess: function(serviceID, cb) {
    var runningService = services[serviceID];
    if (runningService) {
      this.killProcess(serviceID);
      delete services[serviceID];
    }
  },
  startDebugServer: function() {
    if (debugServerChild) {
      console.log('Debug server was already started.');
      return;
    }
    console.log('Starting debug server on port ' +
                config.NODE_INSPECTOR_WEB_PORT+ '...');

    var inspectorPath = './node_modules/node-inspector/bin/inspector.js';

    var child = new (forever.Monitor)(
      inspectorPath,
      {
        max : 100,
        silent : true,
        args: [
          '--web-port', config.NODE_INSPECTOR_WEB_PORT,
          '--save-live-edit', 'true'
        ]
      }
    );

    child.start();

    debugServerChild = child;
    child.on('restart', function() {
      console.log("Debug server was restarted automatically");
    });

    child.on('stdout', function (data) {
      console.log('inspector > ', data.toString());
    });

    child.on('stderr', function (data) {
      console.log('inspector > ', data.toString());
    });

    child.on('exit', function(exitCode) {
      console.log('Closed before stop: Closing code: ', exitCode);
    });

    process.on('exit', function() {
      debugServerChild.kill('SIGKILL');
    });
  },
  shutdownDebugServer: function() {
    if (debugServerChild) {
      console.log('kill debug server');
      debugServerChild.kill('SIGKILL');
      debugServerChild = null;
    }
  }
};

module.exports = ServiceManager;