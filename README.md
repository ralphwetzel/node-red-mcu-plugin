# node-red-mcu-plugin
Plugin to support the Node-RED implementation for microcontrollers (MCUs)

## Overview
This is an endeavor to integrate [node-red-mcu](https://github.com/phoddie/node-red-mcu) into the Node-RED environment.

The plugin adds a side panel labeled "MCU".

<img alt="mcu_panel" src="resources/mcu_panel.png"
    style="min-width: 474px; width: 474px; align: center; border: 1px solid lightgray;"/>

The top section of this side panel allows to select the flows that shall be build for the MCU environment.
Please be aware that **you have to deploy the selected flows** after you've made your choice.

In the bottom section of the side panel, several configurations defining compiler options may be prepared. This allows e.g. to select the target platform or the port used to address a dedicated hardware device. For option reference, see the `mcconfig` [documentation](https://github.com/Moddable-OpenSource/moddable/blob/public/documentation/tools/tools.md#arguments) of the Moddable SDK.

Building the selected flows is as simple as triggering the `Build` button of one of the defined build configurations.

You may follow the build process on the tab `Console Monitor`.

## Implemented Functionality

- [x] Select flows to build.
- [x] UI to define build parameters.
- [x] Console monitor - to follow the build process.
- [x] Display status message of a node (running @ MCU) in the editor.
- [x] Forward user trigger (e.g. `inject` node) to MCU.
- [ ] Debug node (from MCU back into the editor).

## Test Case
We're able to run this (currently minimalistic) flow @ the MCU simulator and display it's feedback into the Node-RED editor.

<img alt="mcu_example" src="resources/mcu_example.png"
    style="min-width: 474px; width: 474px; align: center; border: 1px solid lightgray;"/>


```
[
    {
        "id": "b8a90445a0b6a4f4",
        "type": "tab",
        "label": "MCU Tester",
        "disabled": false,
        "info": "",
        "env": [],
        "_mcu": true
    },
    {
        "id": "7fe927c5ce70aff8",
        "type": "inject",
        "z": "b8a90445a0b6a4f4",
        "name": "",
        "props": [
            {
                "p": "payload"
            }
        ],
        "repeat": "",
        "crontab": "",
        "once": false,
        "onceDelay": "3",
        "topic": "",
        "payload": "",
        "payloadType": "date",
        "_mcu": true,
        "x": 200,
        "y": 260,
        "wires": [
            [
                "799b7e8fcf64e1fa"
            ]
        ]
    },
    {
        "id": "799b7e8fcf64e1fa",
        "type": "debug",
        "z": "b8a90445a0b6a4f4",
        "name": "Debug from MCU",
        "active": true,
        "tosidebar": true,
        "console": false,
        "tostatus": true,
        "complete": "true",
        "targetType": "full",
        "statusVal": "payload",
        "statusType": "msg",
        "_mcu": true,
        "x": 430,
        "y": 260,
        "wires": []
    }
]
```

## Prerequisites
1) [node-red](https://www.nodered.org)
2) [Moddable SDK](https://github.com/Moddable-OpenSource/moddable)

## Installation

```
cd <path to your .node-red folder>
npm install https://github.com/ralphwetzel/node-red-mcu-plugin
```