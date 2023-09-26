const cheerio = require('cheerio');
const rp = require('request-promise-native');
var request = require('request-promise-native');
var ByteBuffer = require("bytebuffer");
var Service;
var Characteristic;

module.exports = function (homebridge) {
    Service = homebridge.hap.Service;
    Characteristic = homebridge.hap.Characteristic;
    homebridge.registerPlatform('homebridge-platform-daikin-itc', 'DaikinITC', SmartACPlatform);
};

function readDaikinString(bb, offset, max) {
    var ret = "";
    for (i = 0; i < max; i++) {
        var c = bb.readCString(offset + i * 2);
        if (c.length == 1)
            break;
        ret += c.string;
    }
    return ret;
}

function getDriveMode(m) {
    console.log("Drive mode: " + m);
    if (m == 1)
        return "Fan";
    if (m == 2)
        return "Heat";
    if (m == 4)
        return "Cool";
    if (m == 32)
        return "Vent";
    if (m == 256)
        return "Heat";
    if (m == 512)
        return "Cool";

}

function SmartACPlatform(log, config) {
    this.log = log;
    this.config = config;
    this.addr = config.addr;
    this.zones = config.zones;
}

SmartACPlatform.prototype.accessories = function (callback) {
    new ThinkEcoAPI(this.log, this.addr, this.zones)
        .getThermostats(function (data) {

            callback(Array.from(data));
        });
};

const UPDATE_FREQUENCY = 2 * 1000; // 2 seconds

// this is a very simple mutex that we use to ensure
// that we make only one concurrent request goes to mymodlet.com
class Lock {
    constructor() {
        this.locked = false;
        this.waiters = [];
    }

    // returns a promise that resolves when the lock is acquired
    acquire() {
        if (this.locked) {
            let notify;
            // the notify() method on the promise object will now
            // resolve that promise. once resolved, it will attempt
            // to reacquire the lock
            const p = new Promise(resolve => notify = resolve)
                .then(() => this.acquire());

            p.notify = notify;
            this.waiters.push(p);
            return p;
        }
        else {
            // if we can acquire the lock straight away, just
            // return an already resolved promise
            this.locked = true;
            return Promise.resolve(true);
        }
    }

    release() {
        this.locked = false;
        const next = this.waiters.shift();
        if (next)
            next.notify(true);
    }
}


// encapsulate the ThinkEco "API" / screen scraping mymodlet.com
// handles retrieving and updating thermostat statuses and maintains
// a cache of all known thermostats in the mymodlet.com account
class ThinkEcoAPI {
    constructor(log, addr, zones) {
        this.lastLogin = new Date(1970, 1, 1);
        this.lastUpdate = new Date(1970, 1, 1);
        this.thermostats = new Map();
        this.session = rp.defaults({ gzip: true, jar: true });
        this.log = log;
        this.lock = new Lock();
        this.addr = addr;
        this.zones = zones;
    }
    async sendReq(req) {
        return request({
            headers: {
                'Cookie': "SETTING=LANG@TYPE=en:LOGIN@USER=admin:LOGIN@GUI=0:DIALOG@webitc.gui.system.DlgUserSetting=533,438:DIALOG@webitc.gui.system.DlgZoneEdit=677,447:TABLE@T6=80,150:TABLE@T7=80,150:TABLE@T8=80,150:TABLE@ST1=150,150,80,80,80:TABLE@T1=60,90,50,50,50,50:TABLE@T2=150,100:",
                'Accept': 'text/html, image/gif, image/jpeg, *; q=.2, */*; q=.2',
                'Content-Type': 'application/octet-stream',
                'Connection': ' keep-alive',
                'Content-Length': req.length
            }, encoding: null,
            uri: this.addr,
            body: req,
            method: 'POST'
        });
    }

    async auth() {
        // Login is not required by Daikin WebITC
    }


    getZones(cb) {
        //Get list of zones w/names
        var bb = new ByteBuffer(100, true)
            .writeInt32(100)//size
            .writeInt32(60102)//COMM
            .fill(0)
            .flip();
        this.sendReq(bb.toBuffer()).then(function (resp2) {

            var zonesResult = ByteBuffer.wrap(resp2, true);
            var nZones = zonesResult.readInt32(20);
            var zones = [];
            for (zoneN = 0; zoneN < nZones; zoneN++) {
                var idx = 32 + 100 * zoneN;
                var zone = {
                    id: zonesResult.readInt32(idx),
                    portNum: zonesResult.readInt32(idx + 8),
                    addr: zonesResult.readInt32(idx + 16),
                    type: zonesResult.readShort(idx + 12),
                    innerType: zonesResult.readShort(idx + 14),
                    sname: readDaikinString(zonesResult, idx + 20, 16)
                    // name: readDaikinString(zonesResult,idx+36,64)
                };
                zones.push(zone);
            }
            cb(zones);
        });
        /*
            });*/
    }


    // return an iterable of all of the Thermostats in the account
    // will retain a reference to and update the current status of
    // all returned Thermostats each time it's called
    async getThermostats(cb) {
        // we only want a single concurrent call to mymodlet.com
        // because this is quite expensive. without a lock, multiple
        // concurrent operations here makes updating multiple attributes
        // on a thermostat(s) is pretty slow.
        await this.lock.acquire();
        var _this = this;
        if (Date.now() - this.lastUpdate > UPDATE_FREQUENCY) {
            this.log('api', 'updating thermostat status...');
            var bb = new ByteBuffer(100, true)
                .writeInt32(100)//size
                .writeInt32(60102)//COMM
                .fill(0)
                .flip();
            this.sendReq(bb.toBuffer()).then(function (resp2) {

                var zonesResult = ByteBuffer.wrap(resp2, true);
                var nZones = zonesResult.readInt32(20);
                var zones = [];
                for (let zoneN = 0; zoneN < nZones; zoneN++) {
                    var idx = 32 + 100 * zoneN;
                    var zone = {
                        id: zonesResult.readInt32(idx),
                        portNum: zonesResult.readInt32(idx + 8),
                        addr: zonesResult.readInt32(idx + 16),
                        type: zonesResult.readShort(idx + 12),
                        innerType: zonesResult.readShort(idx + 14),
                        sname: readDaikinString(zonesResult, idx + 20, 16)
                        // name: readDaikinString(zonesResult,idx+36,64)
                    };
                    if (_this.zones && _this.zones[zone.sname])
                        zone.sname = _this.zones[zone.sname];
                    let thermostat = _this.thermostats.get(zone.id);
                    if (!thermostat) {
                        thermostat = new Thermostat(_this, zone.id, zone.sname);
                        _this.thermostats.set(zone.id, thermostat);
                    }
                    // zones.push(zone);
                }
                cb(_this.thermostats.values());
            });
            this.lastUpdate = Date.now();
        }
        else
            cb(_this.thermostats.values());
        this.lock.release();
    }

    // push an update for the given thermostat (e.g., new temp and/or on/off)
    // returns a boolean indicating if mymodlet.com told us if it was successful
    async pushUpdate(thermostat) {
        await this.auth();
        const r = await this.session.post(
            {
                uri: 'https://mymodlet.com/SmartAC/UserSettings',
                body: {
                    'applianceId': thermostat.id,
                    'targetTemperature': '' + thermostat.targetTemp,
                    'thermostated': thermostat.powerOn
                },
                json: true
            });
        return r.Success;
    }
}

function toC(fahrenheit) {
    return (fahrenheit - 32) * .5556;
}

function toF(celsius) {
    return Math.round(celsius / .5556 + 32);
}

class Thermostat {

    constructor(api, id, name) {
        this.api = api;
        this.id = id;
        this.name = name;
        this.lastUpdate = new Date(1970, 1, 1);
        this.actualTemp = 0;
        this.setTemp = 0;
        this.run_mode = "Unknown";
        this.on_mode = "OFF";
        this.lock = new Lock();
    }

    async updateZoneTemp() {
        var _this = this;
        var bb = new ByteBuffer(32, true)
            .writeInt32(32)//size, start 0
            .writeInt32(60114) //ComGetPntStateDetail, @4

            .writeInt32(this.id)//@8
            // .writeInt32(0)
            .writeInt32(9) //arg1
            .fill(0).flip();
        let res = await this.api.sendReq(bb.toBuffer());
        var b = ByteBuffer.wrap(res, true);
        var i = b.readInt32(60);
        var temp1, temp2;
        if (i & 0x1 != 0)
            temp1 = b.readFloat(64);
        else
            temp1 = 0;
        if (i & 0x2 != 0)
            temp2 = b.readFloat(68);
        else
            temp2 = 0;
        _this.setTemp = temp1;
        _this.actualTemp = temp2;
        _this.run_mode = getDriveMode(b.readInt32(44));
        _this.on_mode = b.readByte(73);
        // if off mode, set run mode to OFF
        if (_this.on_mode == 0) {
            _this.run_mode = "OFF";
        }
        _this.api.log(_this.name, "New set temp " + temp1 + ", " + temp2);
        // cb(_this);
        return this;
    }

    setZoneTemp(tempC, cb) {
        var bb = new ByteBuffer(68, true)
            .writeInt32(68) //size @0
            .writeInt32(60112)//COMM@4
            .writeInt32(this.id)//zone @8
            .fill(0)
            .writeInt32(0, 32) //new state, if set also need to set byte 52 to 1
            .writeInt32(0, 36) //new mode, if set also need to set byte 53 to 1
            .writeFloat(tempC, 48) //new temp, if set also need to set byte 54 to 1
            .writeByte(0, 52) //flag to indicate new state
            .writeByte(0, 53) //flag to indicate new mode
            .writeByte(1, 54) //flag to indicate new temp
            .flip();
        // console.log(bb.toString("debug"));
        this.api.sendReq(bb.toBuffer()).then(function (res) {
            cb(null, tempC);
            // console.log("Finished sending");
            // console.log(res);
            // getZoneTemp(zone,function(v){
            //     console.log("New temp: ");
            //     console.log(v);
            // })
        });
    }

    setState(state, cb) {
        if (state == 0) {
            var bb = new ByteBuffer(40, true)
                .writeInt32(40) //size @0
                .writeInt32(60106)//COMM@4
                .fill(0)
                .writeInt32(1, 28)
                .writeInt32(this.id, 36)//zone @8
                .flip();
            // console.log(bb.toString("debug"));
            this.api.sendReq(bb.toBuffer()).then(function (res) {
                cb(null, state);
            });
        }
        else {
            //on...
            if (state == 1) {
                //cooling
                var bb = new ByteBuffer(68, true)
                    .writeInt32(68) //size @0
                    .writeInt32(60112)//COMM@4
                    .writeInt32(this.id)//zone @8
                    .fill(0)
                    .writeInt32(1, 32) //new state, if set also need to set byte 52 to 1
                    .writeInt32(4, 36) //new mode, if set also need to set byte 53 to 1
                    .writeFloat(0, 48) //new temp, if set also need to set byte 54 to 1
                    .writeByte(1, 52) //flag to indicate new state
                    .writeByte(1, 53) //flag to indicate new mode
                    .writeByte(0, 54) //flag to indicate new temp
                    .flip();
                this.api.sendReq(bb.toBuffer()).then(function (res) {
                    cb(null, state);
                });
            }
            else if (state == 2) {
                //heating
                var bb = new ByteBuffer(68, true)
                    .writeInt32(68) //size @0
                    .writeInt32(60112)//COMM@4
                    .writeInt32(this.id)//zone @8
                    .fill(0)
                    .writeInt32(1, 32) //new state, if set also need to set byte 52 to 1
                    .writeInt32(2, 36) //new mode, if set also need to set byte 53 to 1
                    .writeFloat(0, 48) //new temp, if set also need to set byte 54 to 1
                    .writeByte(1, 52) //flag to indicate new state
                    .writeByte(1, 53) //flag to indicate new mode
                    .writeByte(0, 54) //flag to indicate new temp
                    .flip();
                this.api.sendReq(bb.toBuffer()).then(function (res) {
                    cb(null, state);
                });
            }
            else if (state == 3) {
                //auto
                var bb = new ByteBuffer(68, true)
                    .writeInt32(68) //size @0
                    .writeInt32(60112)//COMM@4
                    .writeInt32(this.id)//zone @8
                    .fill(0)
                    .writeInt32(1, 32) //new state, if set also need to set byte 52 to 1
                    .writeInt32(64, 36) //new mode, if set also need to set byte 53 to 1
                    .writeFloat(0, 48) //new temp, if set also need to set byte 54 to 1
                    .writeByte(1, 52) //flag to indicate new state
                    .writeByte(1, 53) //flag to indicate new mode
                    .writeByte(0, 54) //flag to indicate new temp
                    .flip();
                this.api.sendReq(bb.toBuffer()).then(function (res) {
                    cb(null, state);
                });
            }

        }
    }


    async update(cb) {
        var _this = this;
        await this.lock.acquire();
        if (Date.now() - this.lastUpdate > UPDATE_FREQUENCY) {
            // _this.api.log(_this.name,"Updating");
            await this.updateZoneTemp();
            this.lastUpdate = Date.now();
            // _this.api.log(_this.name,"Done Updating");
            cb(_this);
        }
        else {
            // _this.api.log(_this.name,"Using cache");
            cb(_this);
        }
        this.lock.release();
    }

    getCurrentHeatingCoolingState(callback) {
        var _this = this;
        this.update(function () {
            var rm = Characteristic.CurrentHeatingCoolingState.OFF;
            if (_this.on_mode == 'ON') {
                _this.api.log(_this.name, 'heating / cooling state: ' + _this.run_mode);

                if (_this.run_mode == "Heat")
                    rm = Characteristic.CurrentHeatingCoolingState.HEAT;
                else if (_this.run_mode == "Cool")
                    rm = Characteristic.CurrentHeatingCoolingState.COOL;
            } else {
                _this.api.log(_this.name, 'heating / cooling state: Off');
            }
            callback(null, rm);
        });
    }

    setTargetHeatingCoolingState(value, callback) {
        this.api.log(this.name, 'target heating / cooling state: ' + value);
        this.setState(value, callback);
        // this.powerOn = value === Characteristic.CurrentHeatingCoolingState.COOL;
        // this.update(callback).then(() => callback(null, value));
    }

    getCurrentTemperature(callback) {
        this.update(function (t) {
            // t.api.log(t.name, 'current temp: ' + t.actualTemp);
            callback(null, t.actualTemp);
        });
    }

    getTargetTemperature(callback) {
        var _this = this;
        this.update(function (t) {
            // t.api.log(t.name, 'target temp: ' + t.setTemp);
            callback(null, t.setTemp);
        });
    }

    setTargetTemperature(value, callback) {
        const targetInF = toF(value);
        this.api.log(this.name, 'set target temp: ' + targetInF + ' / ' + value);
        this.targetTemp = value;

        if (this.targetTemp != this.setTemp) {
            //Need to ask daikin to set new temp
            this.setZoneTemp(this.targetTemp, callback);
            this.setTemp = this.targetTemp;

        }
        // this.update().then(() => callback(null, value));
    }

    getTemperatureDisplayUnits(callback) {
        // this.api.log(this.name, 'temperature display units');
        callback(null, Characteristic.TemperatureDisplayUnits.FAHRENHEIT);
    }

    // homebridge calls this function to learn about the thermostat
    getServices() {
        const thermostatService = new Service.Thermostat(this.name);

        thermostatService
            .getCharacteristic(Characteristic.CurrentHeatingCoolingState)
            .on('get', this.getCurrentHeatingCoolingState.bind(this));

        thermostatService
            .getCharacteristic(Characteristic.TargetHeatingCoolingState)
            .on('get', this.getCurrentHeatingCoolingState.bind(this))
            .on('set', this.setTargetHeatingCoolingState.bind(this));

        // the next two characteristics work in celsius in the homekit api
        // min/max controls what the ios home app shows for the range of control
        thermostatService
            .getCharacteristic(Characteristic.CurrentTemperature)
            .setProps({ minValue: 5, maxValue: 40, minStep: 0.1 })
            .on('get', this.getCurrentTemperature.bind(this));

        thermostatService
            .getCharacteristic(Characteristic.TargetTemperature)
            .setProps({ minValue: 15, maxValue: 33, minStep: 0.1 })
            .on('get', this.getTargetTemperature.bind(this))
            .on('set', this.setTargetTemperature.bind(this));

        thermostatService
            .getCharacteristic(Characteristic.TemperatureDisplayUnits)
            .on('get', this.getTemperatureDisplayUnits.bind(this));

        const informationService = new Service.AccessoryInformation()
            .setCharacteristic(Characteristic.Manufacturer, 'Daikin')
            .setCharacteristic(Characteristic.Model, 'WebITC')
            .setCharacteristic(Characteristic.SerialNumber, 'Not Applicable');

        return [informationService, thermostatService];
    }
}
