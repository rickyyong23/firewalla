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
var winston = require('winston');

module.exports = function (component, loglevel) {
    var logger = new(winston.Logger)({
        transports: [
            new(winston.transports.Console)({
                level: loglevel,
                'timestamp': true
            }),
            /*
            new (winston.transports.File)({level:fileloglevel,
                                       name:'log-file',
                                       filename: 'net.log',
                                       dirname: ".",
                                       maxsize: 1000,
                                       maxFiles: 10,
                                       timestamp:true })
*/
        ]
    });
    logger.transports.console.level = loglevel;
    return logger;
};
