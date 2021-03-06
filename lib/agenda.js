var Job = require('./job.js'),
  humanInterval = require('human-interval'),
  utils = require('util'),
  Emitter = require('events').EventEmitter,
  mongo = require('mongoskin');

var Agenda = module.exports = function(config) {
  if(!(this instanceof Agenda)) return new Agenda(config);
  if(!config) config = {};
  this._name = config.name;
  this._processEvery = humanInterval(config.processEvery) || humanInterval('5 seconds');
  this._defaultConcurrency = config.defaultConcurrency || 5;
  this._maxConcurrency = config.maxConcurrency || 20;
  this._definitions = {};
  this._runningJobs = [];
  this._jobQueue = [];
  this._defaultLockLifetime = config.defaultLockLifetime || 10 * 60 * 1000; //10 minute default lockLifetime
  if(config.db)
    this.database(config.db.address, config.db.collection);
  else if(config.mongo)
    this._db =  config.mongo;
};

utils.inherits(Agenda, Emitter);

// Configuration Methods

Agenda.prototype.mongo = function(db) {
  this._db = db;
  return this;
};

Agenda.prototype.database = function(url, collection) {
  collection = collection || 'agendaJobs';
  if (!url.match(/^mongodb:\/\/.*/)) {
    url = 'mongodb://' + url;
  }

  this._db = mongo.db(url, {w: 0}).collection(collection);
  return this;
};

Agenda.prototype.name = function(name) {
  this._name = name;
  return this;
};

Agenda.prototype.processEvery = function(time) {
  this._processEvery = humanInterval(time);
  return this;
};

Agenda.prototype.maxConcurrency = function(num) {
  this._maxConcurrency = num;
  return this;
};

Agenda.prototype.defaultConcurrency = function(num) {
  this._defaultConcurrency = num;
  return this;
};

Agenda.prototype.defaultLockLifetime = function(ms){
  this._defaultLockLifetime = ms;
  return this;
};

// Job Methods
Agenda.prototype.create = function(name, data) {
  var priority = this._definitions[name] ? this._definitions[name].priority : 0;
  var job = new Job({name: name, data: data, type: 'normal', priority: priority, agenda: this});
  return job;
};

Agenda.prototype.jobs = function() {
  var args = Array.prototype.slice.call(arguments);

  if(typeof args[args.length - 1] == 'function') {
    args.push(findJobsResultWrapper(this, args.pop()));
  }

  return this._db.findItems.apply(this._db, args);
};

Agenda.prototype.purge = function(cb) {
  var definedNames = Object.keys(this._definitions);
  this._db.remove({name: {$not: {$in: definedNames}}}, cb);
};

Agenda.prototype.define = function(name, options, processor) {
  if(!processor) {
    processor = options;
    options = {};
  }
  this._definitions[name] = {
    fn: processor,
    concurrency: options.concurrency || this._defaultConcurrency,
    priority: options.priority || 0,
    lockLifetime: options.lockLifetime || this._defaultLockLifetime,
    running: 0
  };
};

Agenda.prototype.every = function(interval, names, data) {
  var self = this;

  if (typeof names === 'string') {
    return createJob(interval, names, data);
  } else if (names instanceof Array) {
    return createJobs(interval, names, data);
  }

  function createJob(interval, name, data) {
    var job;
    job = self.create(name, data);
    job.attrs.type = 'single';
    job.repeatEvery(interval);
    job.save();
    return job;
  }

  function createJobs(interval, names, data) {
    return names.map(function (name) {
      return createJob(interval, name, data);
    });
  }
};

Agenda.prototype.schedule = function(when, names, data) {
  var self = this;

  if (typeof names === 'string') {
    return createJob(when, names, data);
  } else if (names instanceof Array) {
    return createJobs(when, names, data);
  }

  function createJob(when, name, data) {
    var job = self.create(name, data);
    job.schedule(when);
    job.save();
    return job;
  }

  function createJobs(when, names, data) {
    return names.map(function (name) {
      return createJob(when, name, data);
    });
  }
};

Agenda.prototype.now = function(name, data) {
  var job = this.create(name, data);
  job.schedule(new Date());
  job.save();
  return job;
};

Agenda.prototype.saveJob = function(job, cb) {
  var fn = cb,
      self = this;

  var props = job.toJSON(),
      newOrUnloaded = typeof props._id == 'undefined';

  delete props._id;

  props.lastModifiedBy = this._name;


  if(props.type == 'single') {
    var now = new Date(),
        protect = {},
        update;
    if(props.nextRunAt && props.nextRunAt <= now) {
      protect.nextRunAt = props.nextRunAt;
      delete props.nextRunAt;
    }

    update = { $set: props };
    if (Object.keys(protect).length > 0) {
      update.$setOnInsert = protect;
    }

    this._db.findAndModify({name: props.name, type: 'single'}, {}, update, {upsert: true, new: true}, processDbResult);
  } else {
    if(job.attrs._id) {
      this._db.findAndModify({_id: job.attrs._id}, {}, {$set: props}, {new: true}, processDbResult);
    }
    else {
      this._db.insert(props, processDbResult);
    }
  }

  function processDbResult(err, res) {
    if(err) throw(err);
    else if(res) {
      if(Array.isArray(res)) {
        res = res[0];
      }

      job.attrs._id = res._id;
      job.attrs.nextRunAt = res.nextRunAt;

      if(job.attrs.nextRunAt && job.attrs.nextRunAt < self._nextScanAt)
        processJobs.call(self, job);
    }

    if(fn) {
      fn(err, job);
    }
  }
};

// Job Flow Methods

Agenda.prototype.start = function() {
  if(!this._processInterval) {
    this._processInterval = setInterval(processJobs.bind(this), this._processEvery);
    process.nextTick(processJobs.bind(this));
  }
};

Agenda.prototype.stop = function(cb) {
  cb = cb || function() { };
  clearInterval(this._processInterval);
  this._processInterval = undefined;
  unlockJobs.call(this, cb);
};

/**
 * Find and lock jobs
 * @param {String} jobName
 * @param {Function} cb
 * @protected
 */
Agenda.prototype._findAndLockNextJob = function(jobName, definition, cb) {
  var now = new Date(),
      lockDeadline = new Date(Date.now().valueOf() - definition.lockLifetime);

  this._db.findAndModify(
    {
      nextRunAt: {$lte: this._nextScanAt},
      $or: [
        {lockedAt: null},
        {lockedAt: {$exists: false}},
        {lockedAt: {$lte: lockDeadline}}
      ],
      name: jobName
    },
    {'priority': -1},
    {$set: {lockedAt: now}},
    {'new': true},
    findJobsResultWrapper(this, cb)
  );
};

/**
 *
 * @param agenda
 * @param cb
 * @return {Function}
 * @private
 */
function findJobsResultWrapper(agenda, cb) {
  return function (err, jobs) {
    if(jobs) {
      //query result can be array or one record
      if(jobs instanceof Array) {
        jobs = jobs.map(createJob.bind(null, agenda));
      } else {
        jobs = createJob(agenda, jobs);
      }
    }

    cb(err, jobs);
  };
}

/**
 * Create Job object from data
 * @param {Object} agenda
 * @param {Object} jobData
 * @return {Job}
 * @private
 */
function createJob(agenda, jobData) {
  jobData.agenda = agenda;
  return new Job(jobData);
}

function unlockJobs(done) {
  function getJobId(j) { return j.attrs._id; }
  var jobIds = this._jobQueue.map(getJobId)
       .concat(this._runningJobs.map(getJobId));
  this._db.update({_id: { $in: jobIds } }, { $set: { lockedAt: null } }, {multi: true}, done);
}

function processJobs(extraJob) {
  var definitions = this._definitions,
    jobName,
    jobQueue = this._jobQueue,
    self = this;

  if(!extraJob) {
    for (jobName in definitions) {
      jobQueueFilling(jobName);
    }
  } else {
    // On the fly lock a job
    var now = new Date();
    self._db.findAndModify({ _id: extraJob.attrs._id, lockedAt: null }, {}, { $set: { lockedAt: now } }, function(err, resp) {
      if(resp) {
        jobQueue.unshift(extraJob);
        jobProcessing();
      }
    });
  }

  function jobQueueFilling(name) {
    var now = new Date();
    self._nextScanAt = new Date(now.valueOf() + self._processEvery),
    self._findAndLockNextJob(name, definitions[name], function (err, job) {
      if(err) {
        throw err;
      }

      if(job) {
        jobQueue.push(job);
        jobQueueFilling(name);
        jobProcessing();
      }
    });
  }

  function jobProcessing() {
    if(!jobQueue.length){
      return;
    }

    var now = new Date();

    var job = jobQueue.pop(),
      name = job.attrs.name,
      jobDefinition = definitions[name];

    if(job.attrs.nextRunAt < now) {
      runOrRetry();
    }
    else {
      setTimeout(runOrRetry, job.attrs.nextRunAt - now);
    }

    function runOrRetry() {
      if(jobDefinition.concurrency > jobDefinition.running &&
        self._runningJobs.length < self._maxConcurrency) {

        self._runningJobs.push(job);
        jobDefinition.running++;

        job.run(processJobResult);
        jobProcessing();
      } else {
        // Put on top to run ASAP
        jobQueue.push(job);
      }
    }
  }

  function processJobResult(err, job) {
    var name = job.attrs.name;

    self._runningJobs.splice(self._runningJobs.indexOf(job), 1);
    definitions[name].running--;

    jobProcessing();
  }
}
