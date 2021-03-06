/*    Copyright 2016 Rottiesoft LLC 
 *
 *    This program is free software: you can redistribute it and/or  modify
 *    it under the terms of the GNU Affero General Public License, version 3,
 *    as published by the Free Software Foundation.
 *
 *    This program is distributed in the hope that it will be useful,
 *    but WITHOUT ANY WARRANTY; without even the implied warranty of
 *    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 *    GNU Affero General Public License for more details.
 *
 *    You should have received a copy of the GNU Affero General Public License
 *    along with this program.  If not, see <http://www.gnu.org/licenses/>.
 */
'use strict';
var log;
var ip = require('ip');
var os = require('os');
var network = require('network');
var stats = require('stats-lite');

var redis = require("redis");
var rclient = redis.createClient();

var SysManager = require('./SysManager.js');
var sysManager = new SysManager('info');
var DNSManager = require('./DNSManager.js');
var dnsManager = new DNSManager('info');
var bone = require("../lib/Bone.js");

rclient.on("error", function (err) {
    console.log("Redis(alarm) Error " + err);
});

var async = require('async');
var instance = null;

var maxflow = 10000;

class FlowGraph {
    constructor(name,flowarray) {
         if (flowarray) {
             this.flowarray = flowarray;
         } else {
             this.flowarray = [];
         }
         this.name = name;
    }

    flowarraySorted(recent) {
        if (recent == true) {
             this.flowarray.sort(function (a, b) {
                 return Number(b[1]) - Number(a[1]);
             })
             return this.flowarray;
        } else {
             this.flowarray.sort(function (a, b) {
                 return Number(a[1]) - Number(b[1]);
             })
             return this.flowarray;
        }
    }


    addFlow(flow) {
         if (flow.flows == null) {
             let flowStart = Math.ceil(Number(flow.__ts) - Number(flow.du));
             let flowEnd = Math.ceil(Number(flow.__ts));
             if (flow.__ts==null) {
                 flowStart = Math.ceil(Number(flow._ts) - Number(flow.du));
                 flowEnd = Math.ceil(Number(flow._ts));
             }
             let ob = Number(flow.ob);
             let rb = Number(flow.rb);
                
             this.addRawFlow(flowStart,flowEnd,ob,rb,flow.ct);
         } else {
             //console.log("$$$ before ",flow.flows);
             for (let i in flow.flows) {
                 let f = flow.flows[i];
                 this.addRawFlow(f[0],f[1],f[2],f[3],1);
             }
             //console.log("$$$ after",this.flowarray);
         }
    }

    addRawFlow(flowStart, flowEnd, ob,rb,ct) {
         let insertindex = 0;

         for (let i in this.flowarray) {
             let e = this.flowarray[i];
             if (flowStart < e[0]) {
                 break;
             }
             if (flowStart<e[1]) {
                 flowStart = e[0];
                 break;
             }
             insertindex = Number(i)+Number(1);
         }

         let removed = Number(0);
         for (let i = insertindex; i <this.flowarray.length;i++) {
             let e = this.flowarray[Number(i)];
             if (e[1]<flowEnd) {
                 ob += e[2];
                 rb += e[3];
                 ct += e[4];
                 removed++;
                 continue;
             } else if (e[1]>=flowEnd) {
                 ob += e[2];
                 rb += e[3];
                 ct += e[4];
                 flowEnd = e[1];
                 removed++;
                 break;
             }
         }

         this.flowarray.splice(insertindex,removed, [flowStart,flowEnd, ob,rb,ct]);
    //     console.log("insertindex",insertindex,"removed",removed,this.flowarray,"<=end");

    }

}

module.exports = class FlowManager {
    constructor(loglevel) {
        if (instance == null) {
            let cache = {};
            instance = this;
            log = require("./logger.js")("FlowManager", loglevel);
        }
        return instance;
    }

    // 
    // {
    //    mostflow: { flow:, std:}
    //    leastflow: { flow:,std:}
    //    total:
    // }   
    // 
    // tx here means to outside
    // rx means inside
    getFlowCharacteristics(_flows, direction, minlength, sdv) {
        log.info("====== Calculating Flow spec of flows", _flows.length, direction, minlength, sdv);
        if (minlength == null) {
            minlength = 500000;
        }
        if (sdv == null) {
            sdv = 4;
        }
        if (_flows.length <= 0) {
            return null;
        }

        let flowspec = {};
        let flows = [];
        flowspec.direction = direction;
        flowspec.txRanked = [];
        flowspec.rxRanked = [];
        flowspec.txRatioRanked = [];

        let txratios = [];
        let rxvalues = [];
        let txvalues = [];
        let shostSummary = {};
        let dhostSummary = {};
        for (let i in _flows) {
            let flow = _flows[i];
            if (flow.rb < minlength && flow.ob < minlength) {
                continue;
            }
            flows.push(flow);

            if (flow.fd == "in") {
                txvalues.push(flow.ob);
            } else if (flow.fd == "out") {
                txvalues.push(flow.rb);
            }
            if (flow.fd == "in") {
                rxvalues.push(flow.rb);
            } else if (flow.fd == "out") {
                rxvalues.push(flow.ob);
            }
            let shost = shostSummary[flow.sh];
            let dhost = dhostSummary[flow.dh];
            if (shost) {
                shost.ob += flow.ob;
                shost.rb += flow.rb;
            } else {
                shostSummary[flow.sh] = {
                    ob: flow.ob,
                    rb: flow.rb
                };
            }
            if (dhost) {
                dhost.ob += flow.ob;
                dhost.rb += flow.rb;
            } else {
                dhostSummary[flow.dh] = {
                    ob: flow.ob,
                    rb: flow.rb
                };
            }

            if (flow.fd == "in") {
                flow.txratio = flow.ob / flow.rb;
                if (flow.rb == 0) {
                    flow.txratio = Math.min(flow.ob, 10);
                }
            } else if (flow.fd == "out") {
                flow.txratio = flow.rb / flow.ob;
                if (flow.ob == 0) {
                    flow.txratio = Math.min(flow.rb);
                }
            } else {
                log.error("FlowManager:FlowSummary:Error", flow);
            }
            txratios.push(flow.txratio);
        }


        if (flows.length <= 1) {
            // Need to take care of this condition
            log.info("FlowManager:FlowSummary", "not enough flows");
            if (flows.length == 1) {
                flowspec.rxRanked.push(flows[0]);
                flowspec.txRanked.push(flows[0]);
                if (flows[0].txratio > 1.5) {
                    flowspec.txRatioRanked.push(flows[0]);
                }
                flowspec.onlyflow = true;
            }
            return flowspec;
        }

        flowspec.txStdev = stats.stdev(txvalues);
        flowspec.rxStdev = stats.stdev(rxvalues);
        flowspec.txratioStdev = stats.stdev(txratios)

        if (flowspec.txStdev == 0) {
            flowspec.txStdev = 1;
        }
        if (flowspec.rxStdev == 0) {
            flowspec.rxStdev = 1;
        }
        if (flowspec.txratioStdev == 0) {
            flowspec.txratioStdev = 1;
        }

        log.debug("txStd Deviation", flowspec.txStdev);
        log.debug("rxStd Deviation", flowspec.rxStdev);
        log.debug("txRatioStd Deviation", flowspec.txratioStdev);
        for (let i in flows) {
            let flow = flows[i];
            if (flow.fd == "in") {
                flow['rxStdev'] = flow.rb / flowspec.rxStdev;
                flow['txStdev'] = flow.ob / flowspec.txStdev;
                flow['txratioStdev'] = flow.txratio / flowspec.txratioStdev;
            } else if (flow.fd == "out") {
                flow['rxStdev'] = flow.ob / flowspec.txStdev;
                flow['txStdev'] = flow.rb / flowspec.rxStdev;
                flow['txratioStdev'] = flow.txratio / flowspec.txratioStdev;
            }
        }

        flows.sort(function (a, b) {
            return Number(b['rxStdev']) - Number(a['rxStdev']);
        })
        let max = 5;
        log.debug("RX ");
        for (let i in flows) {
            let flow = flows[i];
            if (flow.rxStdev < sdv) {
                continue;
            }
            log.debug(flow,{});
            flowspec.rxRanked.push(flow);
            max--;
            if (max < 0) {
                break;
            }
        }
        flows.sort(function (a, b) {
            return Number(b['txStdev']) - Number(a['txStdev']);
        })
        max = 5;
        log.debug("TX ");
        for (let i in flows) {
            let flow = flows[i];
            if (flow.txStdev < sdv) {
                continue;
            }
            log.debug(flow,{});
            flowspec.txRanked.push(flow);
            max--;
            if (max < 0) {
                break;
            }
        }
        flows.sort(function (a, b) {
            return Number(b['txratioStdev']) - Number(a['txratioStdev']);
        })
        max = 5;
        log.debug("TX Ratio");
        for (let i in flows) {
            let flow = flows[i];
            if (flow.txratioStdev < sdv || flow.txratio < 1) {
                continue;
            }
            log.debug(flow,{});
            flowspec.txRatioRanked.push(flow);
            max--;
            if (max < 0) {
                break;
            }
        }

        return flowspec;

        //     console.log("ShostSummary", shostSummary, "DhostSummary", dhostSummary);

    }

    /* given a list of flows, break them down to conversations
     *  
     * produce a summary of flows like
     *   {::flow:: + duration } ...
     */
    getAppSummary(flow, callback) {

    }

    // block is in seconds
    summarizeBytes(hosts, from, to, block, callback) {
        let sys = {};
        sys.inbytes = 0;
        sys.outbytes = 0;
        sys.flowinbytes = [];
        sys.flowoutbytes = [];
        async.eachLimit(hosts, 5, (host, cb) => {
            let listip = []
            listip.push(host.o.ipv4Addr);
            if (host.ipv6Addr && host.ipv6Addr.length > 0) {
                for (let j in host['ipv6Addr']) {
                    listip.push(host['ipv6Addr'][j]);
                }
            }
            host.flowsummary = {};
            host.flowsummary.inbytes = 0;
            host.flowsummary.outbytes = 0;
            let flows = [];
            async.eachLimit(listip, 5, (ip, cb2) => {
                let key = "flow:conn:" + "in" + ":" + ip;
                rclient.zrevrangebyscore([key, from, to,'withscores','limit',0,maxflow], (err, result) => {
                    log.info("SummarizeBytes:",key,from,to,result.length);
                    host.flowsummary.inbytesArray = [];
                    host.flowsummary.outbytesArray = [];
                    if (err == null) {
                        /* there is an issue here where if the flow started long ago, 
                           it may not show up.  the ts in connection is the starting time
                        */
                        for (let i=0;i<result.length;i++) {
                            let o = JSON.parse(result[i]);
                            if (o == null) {
                                log.error("Host:Flows:Sorting:Parsing", result[i]);
                                i++;
                                continue;
                            }
                            o._ts = Number(result[i+1]); 
                            if (o._ts<to) {
                                i++;
                                continue;
                            }  
                            i++;
                            sys.inbytes += o.rb;
                            sys.outbytes += o.ob;
                            host.flowsummary.inbytes += o.rb;
                            host.flowsummary.outbytes += o.ob;
                            flows.push(o);
                        }
                    }
                    let okey = "flow:conn:" + "out" + ":" + ip;
                    rclient.zrevrangebyscore([okey, from, to,'withscores','limit',0,maxflow], (err, result) => {
                        if (err == null) {
                            for (let i=0;i<result.length;i++) {
                                let o = JSON.parse(result[i]);
                                if (o == null) {
                                    log.error("Host:Flows:Sorting:Parsing", result[i]);
                                    i++;
                                    continue;
                                }
                                o._ts = Number(result[i+1]);
                                if (o._ts<to) {
                                    i++;
                                    continue;
                                }
                                i++;
                                sys.inbytes += o.ob;
                                sys.outbytes += o.rb;
                                host.flowsummary.inbytes += o.ob;
                                host.flowsummary.outbytes += o.rb;
                                flows.push(o);
                            }
                        }
                        cb2();
                    });
                });
            }, (err) => {
                //  break flows down in to blocks
                let btime = from - block;
                let flowinbytes = [];
                let flowoutbytes = [];
                let currentFlowin = 0;
                let currentFlowout = 0;

                flows.sort(function (a, b) {
                    return Number(b._ts) - Number(a._ts);
                })
                for (let i in flows) {
                    let flow = flows[i];
                    if (flow._ts > btime) {
                        if (flow.fd == "in") {
                            currentFlowin += flow.rb;
                            currentFlowout += flow.ob;
                        } else {
                            currentFlowin += flow.ob;
                            currentFlowout += flow.rb;
                        }
                    } else {
                        flowinbytes.push({
                            ts: btime,
                            size: currentFlowin
                        });
                        flowoutbytes.push({
                            ts: btime,
                            size: currentFlowout
                        });
                        let j = flowinbytes.length - 1;
                        if (sys.flowinbytes[j]) {
                            sys.flowinbytes[j].size += currentFlowin;
                        } else {
                            sys.flowinbytes[j] = {
                                ts: btime,
                                size: currentFlowin
                            };
                        }
                        if (sys.flowoutbytes[j]) {
                            sys.flowoutbytes[j].size += currentFlowout;
                        } else {
                            sys.flowoutbytes[j] = {
                                ts: btime,
                                size: currentFlowout
                            };
                        }
                        btime = btime - block;
                        currentFlowin = 0;
                        currentFlowout = 0;
                    }
                }
                host.flowsummary.flowinbytes = flowinbytes;
                host.flowsummary.flowoutbytes = flowoutbytes;

                cb();
            });
        }, (err) => {
            console.log(sys);
            callback(err, sys);
        });
    }

    summarizeActivityFromConnections(flows,callback) {
        let appdb = {};
        let activitydb = {};

        for (let i in flows) {
            let flow = flows[i];
            if (flow.flows) {
                 let fg = new FlowGraph("raw");
                 //console.log("$$$ Before",flow.flows);
                 for (let i in flow.flows) {
                       let f = flow.flows[i];
                       let count = f[4];
                       if (count ==null) {
                           count =1;
                       }
                       fg.addRawFlow(f[0],f[1],f[2],f[3],count);
                 }
                 flow.flows = fg.flowarray;
                 //console.log("$$$ After",flow.flows);
            }
            if (flow.appr) {
                if (appdb[flow.appr]) {
                    appdb[flow.appr].push(flow);
                } else {
                    appdb[flow.appr] = [flow];
                }
            }
            if (flow.intel && flow.intel.c && flow.intel.c!="intel") {
                if (activitydb[flow.intel.c]) {
                    activitydb[flow.intel.c].push(flow);
                } else {
                    activitydb[flow.intel.c] = [flow];
                }
            }
        }

/*
        console.log("--------------appsdb ---- ");
        console.log(appdb);
        console.log("--------------activitydb---- ");
        console.log(activitydb);
*/
        console.log(activitydb);
 
        let flowobj = {id:0,app:{},activity:{}};
        let hasFlows = false;

        for (let i in appdb) {
            let f = new FlowGraph(i);
            for (let j in appdb[i]) {
                f.addFlow(appdb[i][j]);
                hasFlows = true;
            }
            flowobj.app[f.name]= f.flowarraySorted(true);
            for (let k in flowobj.app[f.name]) {
                let _f = flowobj.app[f.name][k];
            }
        }
        for (let i in activitydb) {
            let f = new FlowGraph(i);
            for (let j in activitydb[i]) {
                f.addFlow(activitydb[i][j]);
                hasFlows = true;
            }
            flowobj.activity[f.name]=f.flowarraySorted(true);;
            for (let k in flowobj.activity[f.name]) {
                let _f = flowobj.activity[f.name][k];
            }
         
        }
        // linear these flows
       
        if (!hasFlows) {
            if (callback) {
                callback(null,null);
            }
            return;
        }

        bone.flowgraph("clean", [flowobj],(err,data)=>{
            if (callback) {
                callback(err,data);
            }
        });
    }

    summarizeConnections(ipList, direction, from, to, sortby, hours, resolve, callback) {
        let sorted = [];
        let conndb = {};
        async.each(ipList, (ip, cb) => {
            let key = "flow:conn:" + direction + ":" + ip;
            rclient.zrevrangebyscore([key, from, to,"limit",0,maxflow], (err, result) => {
                //log.debug("Flow:Summarize",key,from,to,hours,result.length);
                let interval = 0;

                if (err == null) {
                    // group together
                    for (let i in result) {
                        let o = JSON.parse(result[i]);
                        if (o == null) {
                            log.error("Host:Flows:Sorting:Parsing", result[i]);
                            continue;
                        }
                        if (o.rb == 0 && o.ob ==0) {
                            // ignore zero length flows
                            continue;
                        }
                        let ts = o.ts;
                        if (o._ts) {
                            ts = o._ts;
                        }
                        if (interval == 0 || ts < interval) {
                            if (interval == 0) {
                                interval = Date.now() / 1000;
                            }
                            interval = interval - hours * 60 * 60;
                            for (let i in conndb) {
                                sorted.push(conndb[i]);
                            }
                            conndb = {};
                        }
                        let key = "";
                        if (o.sh == ip) {
                            key = o.dh + ":" + o.fd;
                        } else {
                            key = o.sh + ":" + o.fd;
                        }
                        //     let key = o.sh+":"+o.dh+":"+o.fd;
                        let flow = conndb[key];
                        if (flow == null) {
                            conndb[key] = o;
                        } else {
                            flow.rb += o.rb;
                            flow.ct += o.ct;
                            flow.ob += o.ob;
                            flow.du += o.du;
                            if (flow.ts < o.ts) {
                                flow.ts = o.ts;
                            }
                            if (o.pf) {
                                for (let i in o.pf) {
                                    if (flow.pf[i] != null) {
                                        flow.pf[i].rb += o.pf[i].rb;
                                        flow.pf[i].ob += o.pf[i].ob;
                                        flow.pf[i].ct += o.pf[i].ct;
                                    } else {
                                        flow.pf[i] = o.pf[i]
                                    }
                                }
                            }
                            if (o.flows) {
                                if (flow.flows) {
                                    flow.flows = flow.flows.concat(o.flows);
                                } else {
                                    flow.flows = o.flows;
                                }
                            }
                        }
                    }

                    for (let i in conndb) {
                        sorted.push(conndb[i]);
                    }
                    conndb = {};


                    cb();
                } else {
                    log.error("Unable to search software");
                    cb();
                }
            });
        }, (err) => {
            if (err) {
                log.error("Flow Manager Error");
                callback(null, sorted);
            } else {
                log.debug("============ Host:Flows:Sorted", sorted.length);
                if (sortby == "time") {
                    sorted.sort(function (a, b) {
                        return Number(b.ts) - Number(a.ts);
                    })
                } else if (sortby == "rxdata") {
                    sorted.sort(function (a, b) {
                        return Number(b.rb) - Number(a.rb);
                    })
                } else if (sortby == "txdata") {
                    sorted.sort(function (a, b) {
                        return Number(b.ob) - Number(a.ob);
                    })
                }

                if (resolve == true) {
                    log.debug("flows:sorted Query dns manager");
                    dnsManager.query(sorted, "sh", "dh", (err) => {
                        if (err != null) {
                            log.error("flow:conn unable to map dns", err);
                        }
                        log.debug("flows:sorted Query dns manager returnes");
                        this.summarizeActivityFromConnections(sorted,(err,activities)=>{
                            callback(null, sorted,activities);
                        });
                    });;
                } else {
                    callback(null, sorted);
                }
            }
        });
    }

    toStringShort(obj) {
        //  // "{\"ts\":1464328076.816846,\"sh\":\"192.168.2.192\",\"dh\":\"224.0.0.251\",\"ob\":672001,\"rb\":0,\"ct\":1,\"fd\":\"in\",\"lh\":\"192.168.2.192\",\"bl\":3600}"
        let ts = Date.now() / 1000;
        let t = ts - obj.ts
        t = (t / 60).toFixed(1);
        let _ts = Date.now() / 1000;
        let _t = _ts - obj._ts
        _t = (_t / 60).toFixed(1);
        let org = "";
        if (obj.org) {
            org = "(" + obj.org + ")";
        }
        let appr = "";
        if (obj.appr) {
            appr = "#" + obj.appr + "#";
        }
        return t+"("+_t+")" + "\t" + obj.du + "\t" + obj.sh + "\t" + obj.dh + "\t" + obj.ob + "\t" + obj.rb + "\t" + obj.ct + "\t" + obj.shname + "\t" + obj.dhname + org + appr;
    }

    toStringShortShort2(obj, type, interest) {
        let sname = obj.sh;
        if (obj.shname) {
            sname = obj.shname;
        }
        let name = obj.dh;
        if (obj.appr && obj.appr.length > 2) {
            name = obj.appr;
        } else if (obj.org && obj.org.length > 2) {
            name = obj.org;
        } else if (obj.dhname && obj.dhname.length > 2) {
            name = obj.dhname;
        }

        let time = Math.round((Date.now() / 1000 - obj.ts) / 60);

        if (type == null) {
            return name + "min : rx " + obj.rb + ", tx " + obj.ob;
        } else if (type == "rxdata" || type == "in") {
            if (interest == 'txdata') {
                return sname + " transfered to " + name + " [" + obj.ob + "] bytes" + " for the duration of " + Math.round(obj.du / 60) + " min. debug: " + obj.rb + type;
            }
            return sname + " transfered to " + name + " " + obj.ob + " bytes" + " for the duration of " + Math.round(obj.du / 60) + " min. debug: " + obj.rb + type;
        } else if (type == "txdata" || type == "out") {
            if (interest == 'txdata') {
                return sname + " transfered to " + name + " : [" + obj.rb + "] bytes" + " for the duration of " + Math.round(obj.du / 60) + " min. debug: " + obj.ob + type;
            }
            return sname + " transfered to " + name + " : " + obj.rb + " bytes" + " for the duration of " + Math.round(obj.du / 60) + " min. debug: " + obj.ob + type;
        }
    }

    toStringShortShort(obj, type) {
        let sname = obj.sh;
        if (obj.shname) {
            sname = obj.shname;
        }
        let name = obj.dh;
        if (obj.appr && obj.appr.length > 2) {
            name = obj.appr;
        } else if (obj.org && obj.org.length > 2) {
            name = obj.org;
        } else if (obj.dhname && obj.dhname.length > 2) {
            name = obj.dhname;
        }

        let time = Math.round((Date.now() / 1000 - obj.ts) / 60);

        if (type == null) {
            return name + "min : rx " + obj.rb + ", tx " + obj.ob;
        } else if (type == "rxdata") {
            return time + "min: " + sname + "->" + name + " " + obj.rb + " bytes";
        } else if (type == "txdata") {
            return time + "min: " + sname + "->" + name + " : " + obj.ob + " bytes";
        }
    }

    sort(sorted, sortby) {
        if (sortby == "time") {
            sorted.sort(function (a, b) {
                return Number(b.ts) - Number(a.ts);
            })
        } else if (sortby == "rxdata") {
            sorted.sort(function (a, b) {
                return Number(b.rb) - Number(a.rb);
            })
        } else if (sortby == "txdata") {
            sorted.sort(function (a, b) {
                return Number(b.ob) - Number(a.ob);
            })
        } else if (sortby == "duration") {
            sorted.sort(function (a, b) {
                return Number(b.du) - Number(a.du);
            })
        }
        return sorted;
    }

}
