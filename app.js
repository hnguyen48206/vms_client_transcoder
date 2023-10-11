const util = require('util');
const exec = util.promisify(require('child_process').exec);
const kill = require('terminate');
const spawn = require('child_process').spawn;
const app = require('express')();
const cors = require('cors');
app.use(cors());
app.options('*', cors());
const server = require('http').Server(app);
var bodyParser = require('body-parser');
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());
const si = require('systeminformation');
var pathToFfmpeg = 'ffmpeg'
const OS = require('os');
const currentOS = OS.platform();
const fs = require('fs');
const EventEmitter = require('eventemitter3');
var stream_ = require('stream');
const { Blob } = require("buffer");

var isFirstFrame = false
const APP_PORT = '1111'
//webm buffer saved
if (global.streamList == null &&
    global.bufferList == null) {
    global.streamList = [];
    global.bufferList = [];
}

//mjpeg buffer saved
if (global.mjpeg_bufferList == null) {
    global.mjpeg_bufferList = [];
}

const path = require('path');
if (currentOS === 'win32')
    pathToFfmpeg = path.join(process.cwd(), 'vms_transcoder_process.exe');
else if (currentOS === 'linux')
    pathToFfmpeg = path.join(process.cwd(), 'vms_transcoder_process');

console.log(pathToFfmpeg)
console.log(process.cwd())

const isRTSP = '-rtsp_transport tcp'
const io = require('socket.io')(server, {
    allowRequest: (req, callback) => {
        const origin = req.headers.origin
        const origins = [
            '*',
            undefined,
            "http://localhost:5500",
            "http://127.0.0.1:5500",
            "http://localhost:8964",
            "http://127.0.0.1:8964",
        ]
        callback(null, origins.includes(origin))
    }
});
server.listen(APP_PORT);

//push ffmpeg mjpeg to httpserver
app.post('/send_mjpeg/:name/@@@*', function (req, res) {
    try {
        let parts = req.originalUrl.split('@@@')
        let input = parts[1]
        let file = req.params.name;
        console.log('Send stream with ID ', file)
        //check to see if this ccid has already been existing
        let existingStreamId = null;
        for (let i = 0; i < global.mjpeg_bufferList.length > 0; ++i) {
            if (global.mjpeg_bufferList[i] != null && global.mjpeg_bufferList[i].id == file) {
                existingStreamId = i; break;
            }
        }

        let latestStreamID = null;
        console.log(existingStreamId)
        if (existingStreamId == null) {
            console.log('Brand-new StreamID')
            global.mjpeg_bufferList.push(
                {
                    id: file,
                    informer: new EventEmitter(),
                    frame: null,
                    internalProcess: null
                }
            )
            latestStreamID = global.mjpeg_bufferList.length - 1;
        }
        else {
            console.log('Existing StreamID')
            global.mjpeg_bufferList[existingStreamId].frame == null;
        }
        ////////////////////////////////////////////////////////////////////////////////////////////////////
        if (input.toString() == 0) {
            //run ffmpeg from outside
            console.log('Start from the external transcoder')
            let buff = Buffer.alloc(0)
            let magicNumber = Buffer.from("FFD8FF", "hex")
            req.on('data', (data) => {
                if (data.length > 1) {
                    buff = Buffer.concat([buff, data]);
                    while (true) {
                        // Find the start of a frame
                        const startIndex = buff.indexOf(magicNumber)
                        if (startIndex < 0) break // start of frame not found              
                        // Find the start of the next frame
                        const endIndex = buff.indexOf(
                            magicNumber,
                            startIndex + magicNumber.length
                        )
                        if (endIndex < 0) break // we haven't got the whole frame yet              
                        // Handle found frame
                        let wholeFrame = buff.slice(startIndex, endIndex)
                        //full frame recieved
                        let isStreamFound = false
                        if (existingStreamId != null) {
                            global.mjpeg_bufferList[existingStreamId].frame = wholeFrame;
                            global.mjpeg_bufferList[existingStreamId].informer.emit('new_frame');
                            // fs.writeFile('image.jpeg', wholeFrame,()=>{});
                            isStreamFound = true;
                        }
                        else if (latestStreamID != null) {
                            global.mjpeg_bufferList[latestStreamID].frame = wholeFrame;
                            global.mjpeg_bufferList[latestStreamID].informer.emit('new_frame');
                            // fs.writeFile('image.jpeg', wholeFrame,()=>{});
                            isStreamFound = true;
                        }
                        // console.log('on full frame')
                        if (!isStreamFound)
                            res.status(500).send('No stream found');


                        buff = buff.slice(endIndex) // remove frame data from current data
                        if (startIndex > 0) console.error(`Discarded ${startIndex} bytes of invalid data`)
                    }
                }
            });
            req.on('close', function () {
                console.log('FFMPEG closed')
                if (existingStreamId != null) {
                    global.mjpeg_bufferList[existingStreamId].informer.emit('src_close');
                    delete global.mjpeg_bufferList[existingStreamId]
                }
                else if (latestStreamID != null) {
                    global.mjpeg_bufferList[latestStreamID].informer.emit('src_close');
                    delete global.mjpeg_bufferList[latestStreamID]
                }

            });
        }
        else {
            //run ffmpeg internally
            try {
                // check resources first
                console.log('Start from the internal transcoder')
                getCurrentSystemResourcesInfo().then(re => {
                    console.log(re)
                    if (re == null || (re != null && re.cpu <= 90 && re.mem <= 90)) {
                        let command = `-fflags nobuffer -flags low_delay ${parts[1].startsWith('rtsp') ? isRTSP : ''} -i ${input} -c:v mjpeg -an -f mjpeg http://localhost:${APP_PORT}/send_mjpeg/${file}/@@@0`
                        console.log(command)
                        let ffmpeg = spawn(pathToFfmpeg, command.split(' '), { windowsHide: true });
                        let isSucceeded = true;
                        ffmpeg.on('close', function (code) {
                            console.log(code)
                            isSucceeded = false;
                        });
                        ffmpeg.stderr.on('data', (data) => {
                            // console.error(`stderr: ${data}`);
                        });
                        if (existingStreamId != null) {
                            if(global.mjpeg_bufferList[existingStreamId].internalProcess!=null)
                            killProcess(global.mjpeg_bufferList[existingStreamId].internalProcess.pid);
                            global.mjpeg_bufferList[existingStreamId].internalProcess = ffmpeg;
                            // console.log(global.mjpeg_bufferList[existingStreamId].internalProcess)
                        }
                        else if (latestStreamID != null) {
                            if(global.mjpeg_bufferList[latestStreamID].internalProcess!=null)
                            killProcess(global.mjpeg_bufferList[latestStreamID].internalProcess.pid);
                            global.mjpeg_bufferList[latestStreamID].internalProcess = ffmpeg;
                            // console.log(global.mjpeg_bufferList[latestStreamID].internalProcess)
                        }

                        setTimeout(() => {
                            if (isSucceeded)
                                res.status(200).send('Thêm luồng thành công');
                            else
                                res.status(500).send('Thêm luồng thất bại');
                        }, 3000);
                    }
                    else {
                        res.status(500).send('Tài nguyên hệ thống đã hết, không thể thêm luồng mới.');
                    }
                })
            } catch (error) {
                console.log(error)
                res.status(500).send(error + '');
            }
        }

    } catch (error) {
        console.log(error)
    }
});
//get ffmpeg mjpeg from httpserver
app.get('/get_mjpeg/:name', (req, res) => {
    let file = req.params.name;
    let stream = null
    console.log('file id: ', file)

    global.mjpeg_bufferList.forEach(buffer => {
        if (file === buffer.id)
            stream = buffer
    })

    if (stream != null) {
        try {
            if (stream.internalProcess != null)
                console.log('Found stream with internal process')
            else
                console.log('Found stream with no internal process')

            res.set({
                'Content-Type': 'multipart/x-mixed-replace; boundary=myboundary',
                'Cache-Control': 'no-cache'
            });
            stream.informer.on('new_frame', data => {
                if (stream.frame != null) {
                    res.write("Content-Type: image/jpeg\r\n");
                    res.write("--myboundary\r\n");
                    res.write("Content-Length: " + stream.frame.length + "\r\n");
                    res.write("\r\n");
                    res.write(stream.frame, 'binary');
                    res.write("\r\n");
                }

            });
            stream.informer.on('src_close', data => {
                console.log('src closed')
                try {
                    res.status(500).send('Stream Source has been closed');
                } catch (error) {
                    console.log(error)
                }
            });
        } catch (error) {
            console.log(error)
        }
    }
    else
        res.status(500).send('No stream found');
    req.on('close', function () {
        console.log('client disconnected')
    });
});
//remove mjpeg stream from server
app.get('/remove_mjpeg/:name', (req, res) => {
    let file = req.params.name;
    let idx = null
    for (let i = 0; i < global.mjpeg_bufferList.length; ++i) {
        if (global.mjpeg_bufferList[i].id === file) {
            idx = i; break;
        }
    }
    if (idx != null) {
        if (global.mjpeg_bufferList[idx].internalProcess != null)
            killProcess(global.mjpeg_bufferList[idx].internalProcess.pid)
        delete global.bufferList[idx];
    }
    res.status(200).send('Stream is removed');
});

//push ffmpeg webm to httpserver
app.post('/send_webm/:name', function (req, res) {
    try {
        let file = req.params.name;
        global.bufferList.push(
            {
                id: file,
                informer: new EventEmitter(),
                frame: null,
                initframe: null
            }
        )
        req.on('data', (frame) => {
            let isStreamFound = false
            for (let i = 0; i < global.bufferList.length; ++i) {
                if (global.bufferList[i].id == file) {
                    if (global.bufferList[i].initframe == null)
                        global.bufferList[i].initframe = frame;
                    else
                        global.bufferList[i].frame = frame;
                    global.bufferList[i].informer.emit('new_frame');
                    isStreamFound = true; break;
                }
            }
            // console.log(isStreamFound)
            if (!isStreamFound)
                res.status(500).send('No stream found');
        });

        req.on('close', function () {
            console.log('FFMPEG closed')
            global.bufferList = global.bufferList.filter(item => {
                return (item.id != file)
            })
        });

    } catch (error) {
        console.log(error)
    }
});
//get ffmpeg webm from httpserver
app.get('/get_webm/:name', (req, res) => {
    let file = req.params.name;
    let stream = null
    global.bufferList.forEach(buffer => {
        console.log('global list: ', buffer.id)
        if (file === buffer.id)
            stream = buffer
    })
    if (stream != null) {
        res.set({
            'Content-Type': 'video/webm',
            'Transfer-Encoding': 'chunked'
        });
        let readable = new stream_.Readable();
        readable.pipe(res);
        readable._read = function () { };
        let isFirstFrameDelivered = false;
        stream.informer.on('new_frame', data => {
            if (stream.initframe != null && !isFirstFrameDelivered) {
                readable.push(stream.initframe);
                isFirstFrameDelivered = true;
            }
            if (stream.initframe != null)
                readable.push(stream.frame);
        });
    }
    else
        res.status(200).send('No stream found');
    req.on('close', function () {
        console.log('client disconnected')
    });
});
//remove webm stream from server
app.get('/remove_webm/:name', (req, res) => {
    let file = req.params.name;
    let idx = null
    for (let i = 0; i < global.bufferList.length; ++i) {
        if (global.bufferList[i].id === file) {
            idx = i; break;
        }
    }
    if (idx != null)
        delete global.bufferList[idx];
    res.status(200).send('Stream is removed');
});

//send and get webm stream internally
app.get('/webm_stream/:id/@@@*', function (req, res) {

    try {
        // check resources first
        getCurrentSystemResourcesInfo().then(re => {
            console.log(re)
            if (re == null || (re != null && re.cpu <= 90 && re.mem <= 90)) {
                console.log(req.method)
                if (req.method == "OPTIONS") {
                    res.set('Access-Control-Allow-Origin', '*');
                    res.set('Access-Control-Allow-Headers', 'Content-Type');
                    res.status(200).send('');
                }
                else {
                    let parts = req.originalUrl.split('@@@')
                    let input = parts[1]

                    // let command = `-re -rtsp_transport tcp -i ${parts[0]} -c:v libx264 -q:v 15 -vf scale=-1:720 -nal-hrd cbr -movflags frag_keyframe+empty_moov+default_base_moof+dash+skip_trailer -f mp4 -`
                    let command = `-fflags nobuffer -flags low_delay ${parts[1].startsWith('rtsp') ? isRTSP : ''} -i ${input} -c:v libvpx-vp9 -vf scale=-1:720 -lossless 1 -row-mt 1 -quality realtime -speed 8 -f webm pipe:1`
                    // let command = `-fflags nobuffer -flags low_delay ${parts[1].startsWith('rtsp') ? isRTSP : ''} -i ${input} -c:v libvpx -crf 10 -b:v 1M -row-mt 1 -quality realtime -speed 8 -f webm pipe:1`
                    // let command = `ffmpeg -re -rtsp_transport tcp -i ${parts[0]} -c:v libtheora -q:v 15 -vf scale=-1:720 -f segment -segment_time 10 -segment_format ogg -movflags frag_keyframe -f ogg -`
                    console.log(command)
                    // let ffmpeg = spawn(`C:/Users/HoangN/Desktop/Nodejs/IVMS_Transcoder/BE/node_modules/ffmpeg-static/ffmpeg.exe`, command.split(' '));
                    let ffmpeg = spawn(pathToFfmpeg, command.split(' '), { windowsHide: true });
                    res.set('Content-Type', 'video/webm');
                    res.set('Transfer-Encoding', 'chunked');
                    ffmpeg.stdout.pipe(res);
                    global.streamList.push({
                        id: req.params.id,
                        stream: ffmpeg,
                        url: input
                    })
                    ffmpeg.on('close', function (code) {
                        console.log('ffmpeg exited with code ' + code);
                        global.streamList = global.streamList.filter(item => {
                            return item.id != req.params.id
                        })
                        res.end();
                    });
                    ffmpeg.stderr.on('data', (data) => {
                        // console.error(`stderr: ${data}`);
                    });
                    req.on('close', function () {
                        killProcess(ffmpeg.pid)
                        global.streamList = global.streamList.filter(item => {
                            return item.id != req.params.id
                        })
                    });
                }
            }
            else {
                res.status(500).send('Tài nguyên hệ thống đã hết, không thể thêm luồng mới.');
            }
        })
    } catch (error) {
        console.log(error)
        res.status(500).send(error + '');
    }    // }


});

app.get('/ivmsstream/closeall', function (req, res) {
    global.streamList.forEach(stream => {
        killProcess(stream.stream.pid);
    });
    res.status(200).send('All streams closed');
});


//stream from recorded file
app.get("/webm/:id", function (req, res) {
    try {
        console.log('here')
        const range = req.headers.range;
        if (!range) {
            res.status(400).send("Requires Range header");
        }
        const videoPath = "test.mp4";
        const videoSize = fs.statSync(videoPath).size;
        const CHUNK_SIZE = 10 ** 6;
        const start = Number(range.replace(/\D/g, ""));
        const end = Math.min(start + CHUNK_SIZE, videoSize - 1);
        const contentLength = end - start + 1;
        const headers = {
            "Content-Range": `bytes ${start}-${end}/${videoSize}`,
            "Accept-Ranges": "bytes",
            "Content-Length": contentLength,
            "Content-Type": "video/mp4",
        };
        res.writeHead(206, headers);
        const videoStream = fs.createReadStream(videoPath, { start, end });
        videoStream.pipe(res);
    } catch (error) {
        console.log(error)
    }

});


function serverStatusHandler(request, response, next) {
    const headers = {
        'Content-Type': 'text/event-stream',
        'Connection': 'keep-alive',
        'Cache-Control': 'no-cache'
    };
    response.writeHead(200, headers);

    const data = `data: ${JSON.stringify({
        message: 'Transcoder Live'
    })}\n\n`;

    response.write(data);

    request.on('close', () => {
        console.log(`Connection closed`);
    });
}

app.get('/transcoder-status', serverStatusHandler);

// const pathToFfmpeg = require('ffmpeg-static');
// const pathToFfmpeg = path.join(appRoot + `/ffmpeg.exe`)
// const ffprobe = require('ffprobe');

Buffer = require('buffer').Buffer;
function getArgs(inputStream, startTime) {
    if (startTime == null)
        return [
            '-loglevel', 'quiet', '-y',
            '-i', `"${inputStream}"`,
            '-r', '20',
            '-q:v', '15',
            '-f', 'image2',
            '-vf', 'scale=-1:720',
            '-update', '1',
            '-'
        ];
    else
        return [
            '-loglevel', 'quiet', '-y',
            '-ss', startTime,
            '-i', `"${inputStream}"`,
            '-r', '20',
            '-q:v', '15',
            '-f', 'image2',
            '-vf', 'scale=-1:720',
            '-update', '1',
            '-'
        ];
}
io.on('connection', socket => {
    console.log('A user connected');
    socket.on('disconnect', function () {
        console.log('A user disconnected');
        global.streamList.forEach(streamItem => {
            if (streamItem.stream != null) {
                killProcess(streamItem.stream.pid);
            }
        })
        global.streamList = [];
    });
    //Khi user muốn bắt đầu play 1 stream thì gửi sự kiện này lên kèm data đã stringtify là 1 object bao gồm streamID và streamURL
    socket.on('streamInfo', function (data) {
        console.log('User wants stream info')
        let input = JSON.parse(data);
        try {
            ffprobe(input.streamURL, { path: 'ffprobe' }).then(res => {
                socket.emit('onStreamInfo_' + input.streamID, res);
            })
        } catch (error) {
            console.log(error)
            socket.emit('onStreamInfoError_' + input.streamID, null);
        }
    });
    socket.on('startNewStream', function (data) {
        let input = JSON.parse(data);
        console.log('A user wants to start stream ' + input.streamID)
        let res = checkIfStreamIsExisting(input.streamURL);
        if (!res.status) {
            // Start stream với streamURL
            let command = getArgs(input.streamURL, null)
            // console.log(command)
            let child = spawn('ffmpeg', command, { shell: true });
            global.streamList.push({
                id: input.streamID,
                stream: child,
                url: input.streamURL
            })
            let buff = Buffer.from('')
            child.stdout.on('data', function (data) {
                //The image can be composed of one or multiple chunk when receiving stream data.
                //Store all bytes into an array until we meet flag "FF D9" that mean it's the end of the image then we can send all data in order to display the full image.
                if (data.length > 1) {
                    buff = Buffer.concat([buff, data]);

                    offset = data[data.length - 2].toString(16);
                    offset2 = data[data.length - 1].toString(16);

                    if (offset == "ff" && offset2 == "d9") {
                        // socket.emit('onStream_' + input.streamID, buff);
                        global.streamList.forEach(stream => {
                            if (stream.url == input.streamURL)
                                socket.emit('onStream_' + stream.id, 'data:image/png;base64,' + buff.toString('base64'));
                        })
                        buff = Buffer.from('');
                    }
                }
            });
            child.stderr.on('data', function (data) {
                // console.log('FFmpeg Error ---- ', data);
            });
            child.on('close', function (code) {
                console.log('Process Killed')
            }.bind(this));
            child.on('error', function (err) {
                if (err.code === 'ENOENT') {
                    console.log('FFMpeg executable wasn\'t found. Install this package and check FFMpeg.cmd property');
                } else {
                    console.log(err);
                }
            });
        }
        else {
            let check = global.streamList.filter(stream => input.streamID == stream.id)
            if (check.length == 0)
                global.streamList.push({
                    id: input.streamID,
                    stream: null,
                    parent_id: res.streamID,
                    url: input.streamURL
                })
        }
    });
    socket.on('startNewStreamWithTime', function (data) {
        let input = JSON.parse(data);
        console.log('A user wants to start stream with specific time ' + input.streamID)
        let res = checkIfStreamIsExisting(input.streamURL);
        if (!res.status) {
            // Start stream với streamURL
            let command = getArgs(input.streamURL, Math.floor(input.startTime / 1000))
            // console.log(command)
            let child = spawn('ffmpeg', command, { shell: true });
            global.streamList.push({
                id: input.streamID,
                stream: child,
                url: input.streamURL
            })
            let buff = Buffer.from('')
            child.stdout.on('data', function (data) {
                //The image can be composed of one or multiple chunk when receiving stream data.
                //Store all bytes into an array until we meet flag "FF D9" that mean it's the end of the image then we can send all data in order to display the full image.
                if (data.length > 1) {
                    buff = Buffer.concat([buff, data]);

                    offset = data[data.length - 2].toString(16);
                    offset2 = data[data.length - 1].toString(16);

                    if (offset == "ff" && offset2 == "d9") {
                        global.streamList.forEach(stream => {
                            if (stream.url == input.streamURL)
                                socket.emit('onStream_' + stream.id, 'data:image/png;base64,' + buff.toString('base64'));
                        })
                        // socket.emit('onStream_' + input.streamID, buff);

                        buff = Buffer.from('');
                    }
                }
            });
            child.stderr.on('data', function (data) {
                // console.log('FFmpeg Error ---- ', data);
            });
            child.on('close', function (code) {
                console.log('Process Killed')
            }.bind(this));
            child.on('error', function (err) {
                if (err.code === 'ENOENT') {
                    console.log('FFMpeg executable wasn\'t found. Install this package and check FFMpeg.cmd property');
                } else {
                    console.log(err);
                }
            });
        }
        else {
            let check = global.streamList.filter(stream => input.streamID == stream.id)
            if (check.length == 0)
                global.streamList.push({
                    id: input.streamID,
                    stream: null,
                    parent_id: res.streamID,
                    url: input.streamURL
                })
        }
    });
    //Khi user muốn stop 1 luồng stream hoặc tất cả các luồng hiện tại thì bắn event sau
    socket.on('stopStream', function (data) {
        let input = JSON.parse(data);

        console.log('A user wants to stop stream ' + (input.streamID != null ? input.streamID : 'all'))
        if (input.isAllStream) {
            global.streamList.forEach(streamItem => {
                if (streamItem.stream != null) {
                    killProcess(streamItem.stream.pid);
                }
            })
            global.streamList = [];
        }
        else if (input.streamID != null) {
            let streamToRemove = new Set();
            streamToRemove.add(input.streamID);
            global.streamList.forEach(streamItem => {
                if (streamItem.id == input.streamID || (streamItem.parent_id != null && streamItem.parent_id == input.streamID)) {
                    if (streamItem.stream != null) {
                        killProcess(streamItem.stream.pid);
                    }
                    else
                        streamToRemove.add(streamItem.id)
                }
            })
            global.streamList = global.streamList.filter(stream => !streamToRemove.has(stream.id))
        }
    });
    socket.on('disconnect', function () {
        global.streamList.forEach(streamItem => {
            if (streamItem.stream != null) {
                killProcess(streamItem.stream.pid);
            }
        })
        global.streamList = [];
    });
    socket.on('startAMQPStream', function (data) {
        let input = JSON.parse(data);
        console.log(input)
        // Calculate the frame size in bytes
        const frameSize = input.frameSize
        console.log('A user wants to start amqp stream ' + input.streamID)
        // Start stream với streamURL
        let command = `-fflags nobuffer -flags low_delay -rtsp_transport tcp -i "${input.streamURL}" -f rawvideo -pix_fmt yuv420p  pipe:1`
        console.log(command)
        let child = spawn('ffmpeg', command.split(' '), { shell: true });

        // const child = spawn('ffmpeg', [
        //     '-i',
        //     input.streamURL,
        //     '-c:v',
        //     'mjpeg',
        //     '-q:v',
        //     '1',
        //     '-f',
        //     'mpjpeg',
        //     '-flush_packets', '1','-'
        //     ]);

        let buffer = Buffer.alloc(0)
        child.stdout.on('data', function (data) {
            try {
                // Append the data to the buffer
                buffer = Buffer.concat([buffer, data]);
                // Loop while the buffer has enough data for a frame
                while (buffer.length >= frameSize) {
                    // Slice the first frame from the buffer & push to the socket
                    let frame = buffer.slice(0, frameSize)
                    // let frame_= frame.toString('base64');               
                    socket.emit('onAMQPFrame_' + input.streamID, {
                        frame: frame,
                        // byteOffset: frame.byteOffset,
                        // length: frame.length
                    });
                    // Remove the frame from the buffer
                    buffer = buffer.slice(frameSize);
                }
                //    socket.emit('onAMQPFrame_' + input.streamID, {
                //         frame: data,
                //     });

            } catch (error) {
                console.log(error)
            }
        });
        child.stderr.on('data', function (data) {

        });
        child.on('close', function (code) {
            console.log(code)
            console.log('Process Killed')
        }.bind(this));
        child.on('error', function (err) {
            console.log(err)
            if (err.code === 'ENOENT') {
                console.log('FFMpeg executable wasn\'t found. Install this package and check FFMpeg.cmd property');
            } else {
                console.log(err);
            }
        });

    });
});

function killProcess(pid) {
    try {
        kill(pid, function (err) {
            if (err) {
                console.log('Error when killing process: ' + pid, err); // handle errors in your preferred way.
            }
            else {
                console.log('done killing process ' + pid); // terminating the Processes succeeded.
            }
        });
    } catch (error) {
        console.log(error)
    }

}
function checkIfStreamIsExisting(stream_url) {
    let foundItem = global.streamList.filter(streamItem => {
        return (streamItem.url == stream_url && streamItem.stream != null)
    })
    if (foundItem.length > 0)
        return foundItem[0]
    else
        return null
}
process.on('exit', function (code) {
    // Following code will never execute.
    console.log('App about to exit with code:', code);
    global.streamList.forEach(streamItem => {
        if (streamItem.stream != null) {
            killProcess(streamItem.stream.pid);
        }
    })
    global.streamList = []
});


// var crypto = require('crypto');

// const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
//     modulusLength: 256,
//     publicKeyEncoding: {
//         type: 'spki',
//         format: 'pem'
//     },
//     privateKeyEncoding: {
//         type: 'pkcs8',
//         format: 'pem'
//     }
// });

// console.log(publicKey.toString('hex'));
// console.log(privateKey.toString('hex'));


// var fs = require('fs');
// const jwt = require("jsonwebtoken");

// app.post('/test_encrypt', function (req, res) {
//     var data = req.body;
//     console.log(data)
//     return res.send(jwt.sign(
//         data,
//         privateKEY,
//         {
//             algorithm: "RS256",
//             expiresIn: '99y',
//         }));
// });

// app.post('/test_verify', function (req, res) {
//     jwt.verify(req.body.token, publicKEY, function (err, decoded) {
//         if (err) {
//             console.log(err.name);
//             if (err.name == 'TokenExpiredError')
//                 return res.send('expired')
//             else
//                 return res.send('invalid')
//         }
//         else
//             return res.send('valid')
//     });

//     return res.send('User has been added successfully');
// });
// var privateKEY = fs.readFileSync('./private.key', 'utf8');
// var publicKEY = fs.readFileSync('./public.key', 'utf8');

process.on('uncaughtException', function (err) {
    console.error(err);
    console.log("Node NOT Exiting...");
});


async function getCurrentSystemResourcesInfo() {
    try {
        let cpu = null
        if (currentOS === 'win32') {
            cpu = await si.currentLoad();
            cpu = Math.round(cpu.currentLoad + (cpu.currentLoad * 0.15))
        }
        else {
            let { stdout, stderr } = await exec(`vmstat 1 2|tail -1|awk '{print $15}'`);
            if (stderr) {
                console.error(`error: ${stderr}`);
                return null
            }
            else {
                // console.log(stdout)
                cpu = Math.round(100 - Number(stdout))
            }
        }

        let mem = await si.mem();
        mem = Math.round(mem.active / mem.total * 100);
        return {
            cpu: cpu, mem: mem
        }
    } catch (error) {
        console.log(error)
        return null
    }
}
