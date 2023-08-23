import { RingApi } from "ring-client-api";
import dotenv from "dotenv";
import { promisify } from 'util'
import { readFile, writeFile, readdir, createReadStream, readFileSync } from 'fs'
import * as path from 'path'
import { exec } from "child_process";
import axios from "axios";

dotenv.config();

const OUTPUT_DIR = process.env.OUTPUT_DIR || './output'
const WEBHOOK_URL = process.env.WEBHOOK_URL || ''

const ringApi = new RingApi({
  refreshToken: process.env.RING_REFRESH_TOKEN!,
  cameraStatusPollingSeconds: 5,
  locationIds: [process.env.RING_LOCATION_ID!],
})

const getMostRecentFile = async (dir: string) => {
  // Find the video file that was created most recently (according to the file name)
  // filename is in the format '%Y-%m-%d_%H-%M-%S_doorbell.mp4'

  const files = await promisify(readdir)(path.resolve(__dirname, dir))

  // Get the most recent file
  const mostRecentFile = files.find((file) => {
    // Split the file name into parts
    const parts = file.split('_')
    if (parts.length < 2) {
      console.log(file, 'is invalid')
      return false
    }

    // Parse the first part into the date
    const date = new Date(parts[0])

    // Add 1 day to the date since days start at 0
    date.setDate(date.getDate() + 1)

    // Split out the time
    const timeParts = parts[1].split('-')
    if (timeParts.length < 3) {
      return false
    }

    // Parse the time 
    date.setHours(parseInt(timeParts[0]))
    date.setMinutes(parseInt(timeParts[1]))
    date.setSeconds(parseInt(timeParts[2]))


    // If the date is invalid, return false
    if (isNaN(date.getTime())) {
      return false
    }

    // If the date is within the last 30 seconds, return true
    const now = new Date()

    if (now.getTime() - date.getTime() < 60 * 1000) {
      return true
    }

    return false
  })

  return mostRecentFile;
}



const main = async () => {


  const locations = await ringApi.getLocations();
  if (locations.length === 0) {
    console.log("No locations found")
    return
  }


  ringApi.onRefreshTokenUpdated.subscribe(
    async ({ newRefreshToken, oldRefreshToken }) => {
      // If you are implementing a project that use `ring-client-api`, you should subscribe to onRefreshTokenUpdated and update your config each time it fires an event
      // Here is an example using a .env file for configuration
      if (!oldRefreshToken) {
        return
      }

      const currentConfig = await promisify(readFile)('.env'),
        updatedConfig = currentConfig
          .toString()
          .replace(oldRefreshToken, newRefreshToken)

      await promisify(writeFile)('.env', updatedConfig)
    }
  )

  for (const location of locations) {
    const cameras = location.cameras;
    console.log('Listening for motion and doorbell presses on your cameras.')

    // For each camera, listen for motion events and log to the console when one occurs
    for (const camera of cameras) {


      const call = await camera.streamVideo({
        // save video 10 second parts so the mp4s are playable and not corrupted:
        // https://superuser.com/questions/999400/how-to-use-ffmpeg-to-extract-live-stream-into-a-sequence-of-mp4
        output: [
          '-flags',
          '+global_header',
          '-f',
          'segment',
          '-segment_time',
          '30', // 10 seconds
          '-segment_format_options',
          'movflags=+faststart',
          '-reset_timestamps',
          '1',
          "-strftime",
          "1",
          path.join(OUTPUT_DIR, '%Y-%m-%d_%H-%M-%S_doorbell.mp4'),
        ],
      })

      call.onCallEnded.subscribe(() => {
        console.log('Call has ended')
        process.exit()
      })


      camera.onMotionDetected.subscribe(async () => {
        console.log(`Motion detected on camera ${camera.name}`)

        const mostRecentFile = await getMostRecentFile(OUTPUT_DIR)

        if (!mostRecentFile) {
          console.log('No recent motion videos found')
          return
        }

        // Move the file to the motion folder
        const motionDir = path.join(OUTPUT_DIR, 'motion')
        await promisify(exec)(`mv ${path.join(OUTPUT_DIR, mostRecentFile)} ${motionDir}`)

        // Send a notification

        const payload: Record<string, any> = {
          "embeds": [
            {
              "title": "Motion Detected",
              "description": `Motion detected on camera ${camera.name}`,
              "color": 15258703,
              "fields": [
                {
                  "name": "Camera Name",
                  "value": camera.name,
                  "inline": true
                },
                {
                  "name": "Location",
                  "value": location.name,
                  "inline": true
                },
                {
                  name: "Time",
                  value: `<t:${Math.floor(new Date().getTime() / 1000)}:F>`,
                  inline: true
                }]
            }],
          "attachments": [{
            "id": 0,
            "description": "Motion Detected",
            "filename": mostRecentFile,
          }]
        }

        const data = new FormData();
        data.append('payload_json', JSON.stringify(payload));

        const fileInMemory = readFileSync(path.join(motionDir, mostRecentFile))

        const blob = new Blob([fileInMemory])
        data.append('files[0]', blob, mostRecentFile);
        axios.postForm(WEBHOOK_URL, data).catch((error) => {
          if (error.response) {
            // The request was made and the server responded with a status code
            // that falls out of the range of 2xx
            console.log(error.response.data);
          } else if (error.request) {
            // The request was made but no response was received
            // `error.request` is an instance of XMLHttpRequest in the browser and an instance of
            // http.ClientRequest in node.js
            console.log(error.request);
          } else {
            // Something happened in setting up the request that triggered an Error
            console.log('Error', error.message);
          }
          console.log(error.config);
        })
      })

    }
  }
}

main()

