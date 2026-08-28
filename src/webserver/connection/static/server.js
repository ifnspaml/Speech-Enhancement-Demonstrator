const express = require('express')
const webserver = express()
    .use((req, res) =>
        res.sendFile('/websocket-client-speaker.html', { root: __dirname }) //TODO: do I have to change this html to audiostream?
    )
    .listen(3000, () => console.log(`Listening on ${3000}`))

const { WebSocketServer } = require('ws')
const sockserver = new WebSocketServer({ port: 443 })
var client_array =[[]];
sockserver.on('connection', ws => {
    let id = Math.random();
    client_array.push([ws, id]);
    console.log('New client connected!')
    ws.send('connection established')
    ws.on('close', () => console.log('Client has disconnected!'))
    ws.on('message', data => {
        client_array.forEach(client => {
            console.log(`distributing message: ${data}`)
            console.log("we are currently sending to the client", client[0]._socket.remotePort)
            client[0].send(`${data} von ${client[1]}`)
        })
    })
    ws.onerror = function () {
        console.log('websocket error')
    }
})

