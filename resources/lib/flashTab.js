/**
 * This code copied over from node-red:
 * packages/node_modules/@node-red/editor-client/src/js/ui/workspaces.js
 
 * *
 * Copyright JS Foundation and other contributors, http://js.foundation
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 **/


let flashingTab;
let flashingTabTimer;

function flashTab(tabId) {
    if(flashingTab && flashingTab.length) {
        //cancel current flashing node before flashing new node
        clearInterval(flashingTabTimer);
        flashingTabTimer = null;
        flashingTab.removeClass('highlighted');
        flashingTab = null;
    }
    let tab = $("#red-ui-tab-" + tabId);
    if(!tab || !tab.length) { return; }

    flashingTabTimer = setInterval(function(flashEndTime) {
        if (flashEndTime >= Date.now()) {
            const highlighted = tab.hasClass("highlighted");
            tab.toggleClass('highlighted', !highlighted)
        } else {
            clearInterval(flashingTabTimer);
            flashingTabTimer = null;
            flashingTab = null;
            tab.removeClass('highlighted');
        }
    }, 100, Date.now() + 2200);
    flashingTab = tab;
    tab.addClass('highlighted');
}