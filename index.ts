import { exec, ExecOptions } from "child_process"
import { join } from "path"
import { evaluateXPath, evaluateXPathToNodes, evaluateXPathToString } from "fontoxpath"
import { Node } from "slimdom"
import { async as parseXmlAsync } from "slimdom-sax-parser"
import { createReadStream } from "fs"

// MARK: Types

export interface SwitchTrackerOptions {
    xmlFile: string,
    pages: number
}

export interface Size {
	width: number
	height: number
}

export interface SwitchDayListItem {
    dateString: string
    weekday: string,
    minutes: number,
    index: number
}

export interface SwitchGameDay extends SwitchDayListItem {
    date: string
}

// MARK: Constants

// Children of this element have the correct index
const PARENT_ID = "com.nintendo.znma:id/recycler_view_fragment_daily_summary"

const TOP_DAY_ID = "com.nintendo.znma:id/card_view_element_daily_summary_top_about_day"
const DAY_ID = "com.nintendo.znma:id/layout_daily_summary_about_day"

const DAY_DATE_ID = "com.nintendo.znma:id/text_view_element_daily_summary_about_top_day"
const DAY_WEEKDAY_ID = "com.nintendo.znma:id/text_view_element_daily_summary_about_top_day_of_week"

const DAY_HOUR_ID = "com.nintendo.znma:id/text_view_element_daily_summary_top_hour"
const DAY_MIN_ID = "com.nintendo.znma:id/text_view_element_daily_summary_top_minute"

const DEFAULT_OUT_FILE = join(__dirname, 'ui.xml')

const time24hInMs = 24 * 60 * 60 * 1000
const maxTimeLookup = 30 * time24hInMs

const DEFAULT_OPTIONS: SwitchTrackerOptions = {
    pages: 4,
    xmlFile: DEFAULT_OUT_FILE
}

// MARK: Commands

const unlockCmd = "adb shell input keyevent 82"

const killAppCmd = "adb shell am force-stop com.nintendo.znma"
const openAppCmd = "adb shell am start -W -n com.nintendo.znma/com.nintendo.nx.moon.SplashActivity"

const dumpUiCmd = "adb shell uiautomator dump"
const buildPullUiCmd = (inFile: string, outFile: string) => `adb pull ${inFile} ${outFile}`

// MARK: Utils

const execOutput = (cmd: string, options: ExecOptions = {}) => {
    return new Promise<string>((resolve, reject) => {
        exec(cmd, options, (error, stdout, stderr) => {
            if (error) {
                return reject(error)
            } else if (stderr) {
                return reject(new Error(stderr))
            } else {
                return resolve(stdout)
            }
        })
    })
}

function numberOrZero(n: any): number {
    if (typeof n === "string") {
        n = parseInt(n)
    }
    return (typeof n === "number" && !isNaN(n) ? n : 0)
}

// MARK: Android

export namespace android {

    export function scrollUp(size: Size, ratio: number) {
        const x = size.width / 2;
        const y0 = size.height * (1 - ratio) / 2;
        const y1 = size.height * (1 + ratio) / 2;
        return execOutput(`adb shell input swipe ${x} ${y0} ${x} ${y1} 300`);
    }

    export function scrollDown(size: Size, ratio: number) {
        const x = size.width / 2;
        const y0 = size.height * (1 + ratio) / 2;
        const y1 = size.height * (1 - ratio) / 2;
        return execOutput(`adb shell input swipe ${x} ${y0} ${x} ${y1} 300`);
    }

    export function killApp() {
        return execOutput(killAppCmd)
    }

    export function openApp() {
        return execOutput(openAppCmd)
    }

    export function unlockPhone() {
        return execOutput(unlockCmd)
    }

    export async function openAppFresh(refreshTimeout = 4000) {
        await killApp()
        await openApp()
        // Wait for the app to refresh
        // TODO: replace timeout with a more reliable method
        await new Promise(resolve => setTimeout(resolve, refreshTimeout))
    }

    export async function getScreenXml(outFile = DEFAULT_OUT_FILE) {
        const dumpOutput = await execOutput(dumpUiCmd)
        const match = dumpOutput.match(/[^\s]+.xml/)
        if (!match) return
        const dumpFile = match[0]
        const pullUiCmd = buildPullUiCmd(dumpFile, outFile)
        await execOutput(pullUiCmd)
    }

    export async function getScreenSize(): Promise<Size> {
        const sizeOutput = await execOutput("adb shell wm size")
        const match = sizeOutput.trim().match(/([\d\.]+)x([\d\.]+)/)
        if (!match) throw new Error(`Screen size not found! output = "${sizeOutput}"`)
        return {width: parseFloat(match[1]), height: parseFloat(match[2])}
    }

}

// MARK: Parsing

export function parseDayNode(node: Node): SwitchDayListItem {
    let date = evaluateXPathToString(`.//node[@resource-id='${DAY_DATE_ID}']/@text`, node)
    let weekday = evaluateXPathToString(`.//node[@resource-id='${DAY_WEEKDAY_ID}']/@text`, node)

    let hour = evaluateXPathToString(`.//node[@resource-id='${DAY_HOUR_ID}']/@text`, node)
    let min = evaluateXPathToString(`.//node[@resource-id='${DAY_MIN_ID}']/@text`, node)
    
    let index = numberOrZero(evaluateXPathToString(`./ancestor::node[../@resource-id='${PARENT_ID}']/@index`, node))

    return {
        dateString: date,
        weekday,
        minutes: numberOrZero(min) + 60 * numberOrZero(hour),
        index
    }
}

export async function parseDaysFromXml(xmlFile = DEFAULT_OUT_FILE) {
    const fileStream = createReadStream(xmlFile, "utf8")
    const xml = await parseXmlAsync(fileStream)
    const nodes = evaluateXPathToNodes<Node>(`//node[@resource-id='${TOP_DAY_ID}']|//node[@resource-id='${DAY_ID}']`, xml, null, null, {language: evaluateXPath.XPATH_3_1_LANGUAGE})
    return nodes.map(parseDayNode)
}

export function appendDaysToList(list: SwitchDayListItem[], days: SwitchDayListItem[]): SwitchDayListItem[] {
    let result = [...list]
    days.forEach(time => {
        if (!time.dateString || !time.weekday) {
            return
        }
        if (!result[time.index]) {
            result[time.index] = time
            return
        }
        let existing = result[time.index]
        // TODO: merge props instead?
        if (existing.minutes < time.minutes) {
            result[time.index] = time
            return
        }
    })
    return result
}

export function inferDateFromList(days: SwitchDayListItem[]): SwitchGameDay[] {
    let now = new Date()
    let today = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 12)

    // get the first item that is a number
    let numDay = days.find(day => day.dateString.match(/\d+/))
    if (!numDay) {
        throw new Error("Failed to find a valid parseable date")
    }
    let monthDate = parseInt(numDay.dateString)
    if (typeof monthDate != "number" || isNaN(monthDate)) {
        throw new Error("Failed to find a valid parseable date")
    }

    // go back in time until you find that number
    let todayTime = today.getTime()
    let numberTime = todayTime
    for (let n = today.getTime(); Math.abs(todayTime - n) < maxTimeLookup; n -= time24hInMs) {
        let nDate = new Date(n)
        if (nDate.getDate() == monthDate) {
            numberTime = n
            break
        }
    }

    return days.map(day => {
        let date = new Date(numberTime - (day.index - numDay!.index) * time24hInMs)
        return {
            ...day,
            date: date.toISOString().substr(0, 10)
        }
    })
}

export async function getSwitchPlayTime(options: Partial<SwitchTrackerOptions> = {}) {
    const { pages, xmlFile } = Object.assign({}, DEFAULT_OPTIONS, options)
    const size = await android.getScreenSize()
    await android.unlockPhone()
    await android.openAppFresh()
    let allTimes: SwitchDayListItem[] = []
    for (let i = 0; i < pages; i++) {
        if (i > 0) {
            await android.scrollDown(size, 0.3)
        }
        await android.getScreenXml(xmlFile)
        const times = await parseDaysFromXml(xmlFile)
        allTimes = appendDaysToList(allTimes, times)
    }
    return inferDateFromList(allTimes)
}
