/**
 * This module spawns an instance of the worker, then submits a given task for
 * this automatically generated workerType and listens for the task completion
 * event.
 */
var slugid = require('slugid');
var request = require('superagent-promise');
var debug = require('debug')('docker-worker:test:testworker');
var util = require('util');

var Task = require('taskcluster-task-factory/task');
var LocalWorker = require('./localworker');
var Queue  = require('taskcluster-client').Queue;
var Scheduler = require('taskcluster-client').Scheduler;
var Listener = require('taskcluster-client').Listener;
var Promise = require('promise');

var queueEvents = new (require('taskcluster-client').QueueEvents);

/** Test provisioner id, don't change this... */
var PROVISIONER_ID = 'no-provisioning-nope';

function* getBody(url) {
  var req = yield request.get(url).end();
  if (req.error) {
    throw new Error('<test> HTTP error while fetching: ' + url);
  }
  return req.body;
}

function taskUrl() {
  var url = 'http://tasks.taskcluster.net/' + util.format.apply(util, arguments);
  return url;
}

function eventPromise(listener, event) {
  return new Promise(function(accept, reject) {
    listener.on(event, function(message) {
      accept(message);
    });
  });
}

function* submitTaskAndGetResults(payload) {
  // Queue http interface.
  var queue = new Queue();
  var scheduler = new Scheduler();
  // Unique worker id so we can't clash with our own tests.
  var workerType = slugid.v4();

  var listener = new Listener({
    connectionString: (yield queue.getAMQPConnectionString()).url
  });

  yield listener.bind(queueEvents.taskCompleted({
    workerType: workerType,
    provisionerId: PROVISIONER_ID
  }));

  yield listener.connect();

  // Create local worker and launch it
  var worker = new LocalWorker(PROVISIONER_ID, workerType);
  // Wait for the worker to be ready to accept messages.
  yield worker.launch();

  var deadline = new Date();
  deadline.setMinutes(deadline.getMinutes() + 10);

  var task = Task.create({
    payload: payload,
    provisionerId: '{{provisionerId}}',
    workerType: '{{workerType}}',
    deadline: deadline.toJSON(),
    timeout: 30,
    metadata: {
      owner: 'unkown@localhost.local',
      name: 'Task from docker-worker test suite',
    }
  });

  var graph = {
    version: '0.2.0',
    tags: {},
    routing: '',
    params: {
      workerType: workerType,
      provisionerId: PROVISIONER_ID
    },
    metadata: task.metadata,
    tasks: [{
      label: 'test_task',
      requires: [],
      reruns: 0,
      task: task
    }]
  };

  // Begin listening at the same time we create the task to ensure we get the
  // message at the correct time.
  var creation = yield [
    eventPromise(listener, 'message'),
    scheduler.createTaskGraph(graph)
  ]

  // Fetch the final result json.
  var status = creation.shift().payload.status;
  var taskId = status.taskId;
  var runId = status.runs.pop().runId;

  var results = yield {
    result: getBody(taskUrl('%s/runs/%s/result.json', taskId, runId)),
    logs: getBody(taskUrl('%s/runs/%s/logs.json', taskId, runId)),
    taskId: taskId
  };

  // Kill the worker we don't need it anymore.
  yield worker.terminate();

  return results;
}

module.exports = submitTaskAndGetResults;