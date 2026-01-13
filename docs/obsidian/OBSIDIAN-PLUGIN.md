Build a plugin
Plugins let you extend Obsidian with your own features to create a custom note-taking experience.

In this tutorial, you'll compile a sample plugin from source code and load it into Obsidian.

What you'll learn 
After you've completed this tutorial, you'll be able to:

Configure an environment for developing Obsidian plugins.
Compile a plugin from source code.
Reload a plugin after making changes to it.
Prerequisites 
To complete this tutorial, you'll need:

Git installed on your local machine.
A local development environment for Node.js.
A code editor, such as Visual Studio Code.
Before you start 
When developing plugins, one mistake can lead to unintended changes to your vault. To prevent data loss, you should never develop plugins in your main vault. Always use a separate vault dedicated to plugin development.

Create an empty vault.

Step 1: Download the sample plugin 
In this step, you'll download a sample plugin to the plugins directory in your vault's .obsidian directory so that Obsidian can find it.

The sample plugin you'll use in this tutorial is available in a GitHub repository.

Open a terminal window and change the project directory to the plugins directory.

cd path/to/vault
mkdir .obsidian/plugins
cd .obsidian/plugins
Clone the sample plugin using Git.

git clone https://github.com/obsidianmd/obsidian-sample-plugin.git
GitHub template repository
The repository for the sample plugin is a GitHub template repository, which means you can create your own repository from the sample plugin. To learn how, refer to Creating a repository from a template.

Remember to use the URL of your own repository when cloning the sample plugin.

Step 2: Build the plugin 
In this step, you'll compile the sample plugin so that Obsidian can load it.

Navigate to the plugin directory.

cd obsidian-sample-plugin
Install dependencies.

npm install
Compile the source code. The following command keeps running in the terminal and rebuilds the plugin when you modify the source code.

npm run dev
Notice that the plugin directory now has a main.js file that contains a compiled version of the plugin.

Step 3: Enable the plugin 
To load a plugin in Obsidian, you first need to enable it.

In Obsidian, open Settings.
In the side menu, select Community plugins.
Select Turn on community plugins.
Under Installed plugins, enable the Sample Plugin by selecting the toggle button next to it.
You're now ready to use the plugin in Obsidian. Next, we'll make some changes to the plugin.

Step 4: Update the plugin manifest 
In this step, you'll rename the plugin by updating the plugin manifest, manifest.json. The manifest contains information about your plugin, such as its name and description.

Open manifest.json in your code editor.
Change id to a unique identifier, such as "hello-world".
Change name to a human-friendly name, such as "Hello world".
Rename the plugin folder to match the plugin's id.
Restart Obsidian to load the new changes to the plugin manifest.
Go back to Installed plugins and notice that the name of the plugin has been updated to reflect the changes you made.

Remember to restart Obsidian whenever you make changes to manifest.json.

Step 5: Update the source code 
To let the user interact with your plugin, add a ribbon icon that greets the user when they select it.

Open main.ts in your code editor.

Rename the plugin class from MyPlugin to HelloWorldPlugin.

Import Notice from the obsidian package.

import { Notice, Plugin } from 'obsidian';
In the onload() method, add the following code:

this.addRibbonIcon('dice', 'Greet', () => {
  new Notice('Hello, world!');
});
In the Command palette, select Reload app without saving to reload the plugin.

You can now see a dice icon in the ribbon on the left side of the Obsidian window. Select it to display a message in the upper-right corner.

Remember, you need to reload your plugin after changing the source code, either by disabling it then enabling it again in the community plugins panel, or using the command palette as detailed in part 5 of this step.

Hot reloading
Install the Hot-Reload plugin to automatically reload your plugin while developing.

Conclusion 
In this tutorial, you've built your first Obsidian plugin using the TypeScript API. You've modified the plugin and reloaded it to reflect the changes inside Obsidian.

---

Anatomy of a plugin
The Plugin class defines the lifecycle of a plugin and exposes the operations available to all plugins:

import { Plugin } from 'obsidian';

export default class ExamplePlugin extends Plugin {
  async onload() {
    // Configure resources needed by the plugin.
  }
  async onunload() {
    // Release any resources configured by the plugin.
  }
}
Plugin lifecycle 
onload() runs whenever the user starts using the plugin in Obsidian. This is where you'll configure most of the plugin's capabilities.

onunload() runs when the plugin is disabled. Any resources that your plugin is using must be released here to avoid affecting the performance of Obsidian after your plugin has been disabled.

To better understand when these methods are called, you can print a message to the console whenever the plugin loads and unloads. The console is a valuable tool that lets developers monitor the status of their code.

To view the console:

Toggle the Developer Tools by pressing Ctrl+Shift+I in Windows and Linux, or Cmd-Option-I on macOS.
Click on the Console tab in the Developer Tools window.
import { Plugin } from 'obsidian';

export default class ExamplePlugin extends Plugin {
  async onload() {
    console.log('loading plugin')
  }
  async onunload() {
    console.log('unloading plugin')
  }
}

---

Development workflow
Whenever you make a change to the plugin source code, the plugin needs to be reloaded. You can reload the plugin by quitting Obsidian and starting it again, but that gets tiring quickly.

Reload plugin inside Obsidian 
You can reload the plugin by re-enabling it in the list of installed plugins:

Open Preferences.
Click Community plugins.
Find your plugin under Installed plugins.
Toggle the switch off to disable the plugin.
Toggle the switch on to enable the plugin.
You're now running the updated version of your plugin.

Reload plugin on file changes 
The Hot-Reload plugin reloads your plugin whenever the source code changes.

---

Use React in your plugin
In this guide, you'll configure your plugin to use React. It assumes that you already have a plugin with a custom view that you want to convert to use React.

While you don't need to use a separate framework to build a plugin, there are a few reasons why you'd want to use React:

You have existing experience of React and want to use a familiar technology.
You have existing React components that you want to reuse in your plugin.
Your plugin requires complex state management or other features that can be cumbersome to implement with regular HTML elements.
Configure your plugin 
Add React to your plugin dependencies:

npm install react react-dom
Add type definitions for React:

npm install --save-dev @types/react @types/react-dom
In tsconfig.json, enable JSX support on the compilerOptions object:

{
  "compilerOptions": {
    "jsx": "react-jsx"
  }
}
Create a React component 
Create a new file called ReactView.tsx in the plugin root directory, with the following content:

export const ReactView = () => {
  return <h4>Hello, React!</h4>;
};
Mount the React component 
To use the React component, it needs to be mounted on a HTML element. The following example mounts the ReactView component on the this.contentEl element:

import { StrictMode } from 'react';
import { ItemView, WorkspaceLeaf } from 'obsidian';
import { Root, createRoot } from 'react-dom/client';
import { ReactView } from './ReactView';

const VIEW_TYPE_EXAMPLE = 'example-view';

class ExampleView extends ItemView {
	root: Root | null = null;

	constructor(leaf: WorkspaceLeaf) {
		super(leaf);
	}

	getViewType() {
		return VIEW_TYPE_EXAMPLE;
	}

	getDisplayText() {
		return 'Example view';
	}

	async onOpen() {
		this.root = createRoot(this.contentEl);
		this.root.render(
			<StrictMode>
				<ReactView />,
			</StrictMode>,
		);
	}

	async onClose() {
		this.root?.unmount();
	}
}
For more information on createRoot and unmount(), refer to the documentation on ReactDOM.

You can mount your React component on any HTMLElement, for example status bar items. Just make sure to clean up properly by calling this.root.unmount() when you're done.

Create an App context 
If you want to access the App object from one of your React components, you need to pass it as a dependency. As your plugin grows, even though you're only using the App object in a few places, you start passing it through the whole component tree.

Another alternative is to create a React context for the app to make it globally available to all components inside your React view.

Use createContext() to create a new app context.

import { createContext } from 'react';
import { App } from 'obsidian';

export const AppContext = createContext<App | undefined>(undefined);
Wrap the ReactView with a context provider and pass the app as the value.

this.root = createRoot(this.contentEl);
this.root.render(
  <AppContext.Provider value={this.app}>
    <ReactView />
  </AppContext.Provider>
);
Create a custom hook to make it easier to use the context in your components.

import { useContext } from 'react';
import { AppContext } from './context';

export const useApp = (): App | undefined => {
  return useContext(AppContext);
};
Use the hook in any React component within ReactView to access the app.

import { useApp } from './hooks';

export const ReactView = () => {
  const { vault } = useApp();

  return <h4>{vault.getName()}</h4>;
};

For more information, refer to the React documentation for Passing Data Deeply with Context and Reusing Logic with Custom Hooks:
 - https://react.dev/learn/passing-data-deeply-with-context
 - https://react.dev/learn/reusing-logic-with-custom-hooks
 

 ---

 Optimize plugin load time
Plugins play an important role in app load time. To ensure that Obsidian behaves correctly, Obsidian loads all plugins before the user can interact with the app.

You can test the startup time of Obsidian by going to Settings → General → Advanced. and select the stopwatch icon to debug startup time. This view indicates how long it takes for the app to launch.

How do I improve my plugin's load time? 
Simplify your plugin onload.
Check your plugin View constructor.
Avoid the common pitfalls.
First, the easy stuff. Make sure that you are using a production build of your plugin. If you are using a bundler like esbuild, rollup, or webpack, you can likely create a "development" build or a "production" build. A production build will usually be smaller, load faster, and remove code that's only used for testing. When you create a release, ensure that the main.js file is a production build.

In your build configuration, you should consider minifying your plugin code. This will make the overall plugin file size smaller and therefore faster for plugin to read from disk and load.

Next, make sure you aren't doing anything expensive inside your plugin's onload function. The onload function should only include code necessary for the plugin to initialize. This includes app registrations, like registering commands, view types, and Markdown post-processors. It should not include anything computationally expensive or data fetching.

If your plugin creates any custom views, be mindful of your custom view constructor. When Obsidian opens, it will reopen all the views saved to the user's workspace. If your view is loaded (and not deferred), this will directly impact the app load time.

If you have code that you want to run at startup, where should it go? 
For most cases, you will want to wrap your code inside a onLayoutReady callback. These callbacks are deferred and are only called after Obsidian finishes loading.

Pitfalls 
Listening to vault.on('create') 
As a part of Obsidian's vault initialization process, it will call create for every file. If your plugin needs to react to new files getting created, you need to wait for the workspace to be ready first. Your vault event registration should be inside an onLayoutReady callback; this will ensure you don't start reacting to events until the workspace is fully initialized.

Option A. Check if the layout is ready 
class MyPlugin extends Plugin {
    onload(app: App) {
	    super(app);
        this.registerEvent(this.app.vault.on('create', this.onCreate, this));
    }

	onCreate() {
	    if (!this.app.workspace.layoutReady) {
	      // Workspace is still loading, do nothing
	      return;
	    }
		// ...
	}
}
Option B. Register the handler once the layout is ready 
class MyPlugin extends Plugin {
    onload(app: App) {
	    super(app);
	    this.app.workspace.onLayoutReady(() => {
	        this.registerEvent(this.app.vault.on('create', this.onCreate, this));
	    });
    }

	onCreate() {
		// ...
	}
}

---

# Support pop-out windows
With the release of Obsidian v0.15.0, the pop-out windows feature was added to the desktop version of Obsidian.

For most plugins, this feature should work out-of-the-box. However, some things work differently when your plugin renders things in pop-out windows.

Most importantly, pop-out windows come with a complete different set of globals. Each pop-out window introduces its own Window object, Document object, and fresh copies of all global constructors (like HTMLElement and MouseEvent).

This means that some of the things you previously had assumed to be global and use only a single definition, will now only work in the main window. Here are some examples:

let myElement: HTMLElement = ...;

// This will always append to the main window
document.body.appendChild(myElement);

// This will actually be false if element is in a pop-out window
if (myElement instanceof HTMLElement) {

}

element.on('click', '.my-css-class', (event) => {
    // This will be false if the event is triggered in a pop-out window
    if (event instanceof MouseEvent) {

    }
}
The Obsidian API includes various helper function and accessors to better support pop-out windows:

A global activeWindow and activeDocument variable, which always points to the current focused window and its document.
An element.win and element.doc getter, which respectively point to the Window and Document objects that the element belongs to.
A function for performing cross-window compatible instanceof checks. Use element.instanceOf(HTMLElement) and event.instanceOf(MouseEvent), instead of element instanceof HTMLElement and event instanceof MouseEvent.
HTMLElement.onWindowMigrated(callback) which hooks a callback on the element for when it is inserted into a different window than it originally was in. This can be used for complex renderers like canvases to re-initialize the rendering context.
Using these APIs, the previous example would look like this:

let myElement: HTMLElement = ...;

// Bad: myElement would be added to the currently focused document, which is not necessarily the one you want
activeDocument.body.appendChild(myElement);
// Good: This will append myElement to the same window as someElement
someElement.doc.body.appendChild(myElement);

// This will work correctly in pop-out windows
if (myElement.instanceOf(HTMLElement)) {

}

element.on('click', '.my-css-class', (event) => {
    // This will work correctly in pop-out windows
    if (event.instanceOf(MouseEvent)) {

    }
}

---

Defer views
As of Obsidian v1.7.2, When Obsidian loads, all views are created as instances of DeferredView. Once a view is visible on screen (i.e. the tab is selected within its containing tab group), the leaf will rerender and the view will be switched out to the correct View instance.

This change might break some assumptions that your plugin is currently making.

Accessing leaf.view 
If your plugin is iterating the workspace (using either iterateAllLeaves or getLeavesOfType), it's now very important that you perform an instanceof check before making any assumptions about leaf.view.

// Bad
workspace.iterateAllLeaves(leaf => {
    if (leaf.view.getViewType() === 'my-view') {
        let view = leaf.view as MyCustomView;
        ...
    }
});

// Good
workspace.iterateAllLeaves(leaf => {
    if (leaf.view instanceof MyCustomView) {
        ...
    }
});
// Bad
let leaf = workspace.getLeavesOfType('my-view').first();
if (leaf) {
	let view = leaf.view as MyCustomView;
}
...

// Good
let leaf = workspace.getLeavesOfType('my-view').first();
if (leaf && leaf.view instanceof MyCustomView) {
    ...
}
This will avoid your plugin breaking by making a bad assumption about the workspace and causing your plugin to error out.

Accessing your CustomView anywhere in the workspace 
A general rule to follow: if your plugin is attempting to communicate with a view, that view should be visible.

If your plugin needs to access an instance of CustomView in the workspace, you might notice that the previous code snippets won't work.

For most use cases, the solution is simple:

let leaf = workspace.getLeavesOfType('my-view').first();
if (leaf) {
	await workspace.revealLeaf(leaf); // Ensure the view is visible, `await` it to make sure the view is fully loaded
	if (leaf.view instanceof MyCustomView) {
		let view = leaf.view; // You now have your CustomView
	}
}
For most cases, this will be the correct way to handle accessing your custom view.

Accessing your CustomView without reveal (Advanced) 
There are some cases where you want to access a view without revealing it. For example, if your plugin is applying modifications to an existing view type.

In this case, you will need to manually request that the view is loaded.

let leaves = workspace.getLeavesOfType('my-view');
for (let leaf of leaves) {
  if (requireApiVersion('1.7.2')) {
    await leaf.loadIfDeferred(); // Ensure view is fully loaded
  }
  // perform modifications here...
}
Performance warning
Manually calling loadIfDeferred, your plugin is removing this performance optimization from the given views. Use this sparingly.






