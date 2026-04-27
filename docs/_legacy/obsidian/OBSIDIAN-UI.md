Context menus
If you want to open up a context menu, use Menu:

import { Menu, Notice, Plugin } from 'obsidian';

export default class ExamplePlugin extends Plugin {
  async onload() {
    this.addRibbonIcon('dice', 'Open menu', (event) => {
      const menu = new Menu();

      menu.addItem((item) =>
        item
          .setTitle('Copy')
          .setIcon('documents')
          .onClick(() => {
            new Notice('Copied');
          })
      );

      menu.addItem((item) =>
        item
          .setTitle('Paste')
          .setIcon('paste')
          .onClick(() => {
            new Notice('Pasted');
          })
      );

      menu.showAtMouseEvent(event);
    });
  }
}
showAtMouseEvent() opens the menu where you clicked with the mouse.

Tip
If you need more control of where the menu appears, you can use menu.showAtPosition({ x: 20, y: 20 }) to open the menu at a position relative to the top-left corner of the Obsidian window.

For more information on what icons you can use, refer to Icons.

You can also add an item to the file menu, or the editor menu, by subscribing to the file-menu and editor-menu workspace events:

context-menu-positions.png

import { Notice, Plugin } from 'obsidian';

export default class ExamplePlugin extends Plugin {
  async onload() {
    this.registerEvent(
      this.app.workspace.on('file-menu', (menu, file) => {
        menu.addItem((item) => {
          item
            .setTitle('Print file path 👈')
            .setIcon('document')
            .onClick(async () => {
              new Notice(file.path);
            });
        });
      })
    );

    this.registerEvent(
      this.app.workspace.on("editor-menu", (menu, editor, view) => {
        menu.addItem((item) => {
          item
            .setTitle('Print file path 👈')
            .setIcon('document')
            .onClick(async () => {
              new Notice(view.file.path);
            });
        });
      })
    );
  }
}

---

HTML elements
Several components in the Obsidian API, such as the Settings, expose container elements:

import { App, PluginSettingTab } from 'obsidian';

class ExampleSettingTab extends PluginSettingTab {
  plugin: ExamplePlugin;

  constructor(app: App, plugin: ExamplePlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    // highlight-next-line
    let { containerEl } = this;

    // ...
  }
}
Container elements are HTMLElement objects that make it possible to create custom interfaces within Obsidian.

Create HTML elements using createEl() 
Every HTMLElement, including the container element, exposes a createEl() method that creates an HTMLElement under the original element.

For example, here's how you can add an <h1> heading element inside the container element:

containerEl.createEl('h1', { text: 'Heading 1' });
createEl() returns a reference to the new element:

const book = containerEl.createEl('div');
book.createEl('div', { text: 'How to Take Smart Notes' });
book.createEl('small', { text: 'Sönke Ahrens' });
Style your elements 
You can add custom CSS styles to your plugin by adding a styles.css file in the plugin root directory. To add some styles for the previous book example:

.book {
  border: 1px solid var(--background-modifier-border);
  padding: 10px;
}

.book__title {
  font-weight: 600;
}

.book__author {
  color: var(--text-muted);
}
Tip
--background-modifier-border and --text-muted are CSS variables that are defined and used by Obsidian itself. If you use these variables for your styles, your plugin will look great even if the user has a different theme! 🌈

To make the HTML elements use the styles, set the cls property for the HTML element:

const book = containerEl.createEl('div', { cls: 'book' });
book.createEl('div', { text: 'How to Take Smart Notes', cls: 'book__title' });
book.createEl('small', { text: 'Sönke Ahrens', cls: 'book__author' });
Now it looks much better! 🎉

styles.png

Conditional styles 
Use the toggleClass method if you want to change the style of an element based on the user's settings or other values:

element.toggleClass('danger', status === 'error');

---

Commands
Commands are actions that the user can invoke from the Command Palette or by using a hot key.

command.png

To register a new command for your plugin, call the addCommand() method inside the onload() method:

import { Plugin } from 'obsidian';

export default class ExamplePlugin extends Plugin {
  async onload() {
    this.addCommand({
      id: 'print-greeting-to-console',
      name: 'Print greeting to console',
      callback: () => {
        console.log('Hey, you!');
      },
    });
  }
}
Conditional commands 
If your command is only able to run under certain conditions, consider using checkCallback() instead.

The checkCallback runs twice. First, to perform a preliminary check to determine whether the command can run. Second, to perform the action.

Since time may pass between the two runs, you need to perform the check during both calls.

To determine whether the callback should perform a preliminary check or an action, a checking argument is passed to the callback.

If checking is set to true, perform a preliminary check.
If checking is set to false, perform an action.
The command in the following example depends on a required value. In both runs, the callback checks that the value is present but only performs the action if checking is false.

this.addCommand({
  id: 'example-command',
  name: 'Example command',
  // highlight-next-line
  checkCallback: (checking: boolean) => {
    const value = getRequiredValue();

    if (value) {
      if (!checking) {
        doCommand(value);
      }

      return true
    }

    return false;
  },
});
Editor commands 
If your command needs access to the editor, you can also use the editorCallback(), which provides the active editor and its view as arguments.

this.addCommand({
  id: 'example-command',
  name: 'Example command',
  editorCallback: (editor: Editor, view: MarkdownView) => {
    const sel = editor.getSelection()

    console.log(`You have selected: ${sel}`);
  },
}
Note
Editor commands only appear in the Command Palette when there's an active editor available.

If the editor callback can only run under certain conditions, consider using editorCheckCallback() instead. For more information, refer to Conditional commands.

this.addCommand({
  id: 'example-command',
  name: 'Example command',
  editorCheckCallback: (checking: boolean, editor: Editor, view: MarkdownView) => {
    const value = getRequiredValue();

    if (value) {
      if (!checking) {
        doCommand(value);
      }

      return true
    }

    return false;
  },
});
Hot keys 
The user can run commands using a keyboard shortcut, or hot key. While they can configure this themselves, you can also provide a default hot key.

Warning
Avoid setting default hot keys for plugins that you intend for others to use. Hot keys are highly likely to conflict with those defined by other plugins or by the user themselves.

In this example, the user can run the command by pressing and holding Ctrl (or Cmd on Mac) and Shift together, and then pressing the letter a on their keyboard.

this.addCommand({
  id: 'example-command',
  name: 'Example command',
  hotkeys: [{ modifiers: ['Mod', 'Shift'], key: 'a' }],
  callback: () => {
    console.log('Hey, you!');
  },
});
Note
The Mod key is a special modifier key that becomes Ctrl on Windows and Linux, and Cmd on macOS.

---

Icons
Several of the UI components in the Obsidian API let you configure an accompanying icon. You can choose from one of the built-in icons, or you can add your own.

Browse available icons 
Browse to lucide.dev to see all available icons and their corresponding names.

Please note: Only icons up to v0.446.0 are supported at this time.

Use icons 
If you'd like to use icons in your custom interfaces, use the setIcon() utility function to add an icon to an HTML element. The following example adds an icon to the status bar:

import { Plugin, setIcon } from 'obsidian';

export default class ExamplePlugin extends Plugin {
  async onload() {
    const item = this.addStatusBarItem();
    setIcon(item, 'info');
  }
}
To change the size of an icon, set the --icon-size CSS variable on the element containing the icon using preset sizes:

div {
  --icon-size: var(--icon-size-m);
}
Add your own icon 
To add a custom icon for your plugin, use the addIcon() utility:

import { addIcon, Plugin } from 'obsidian';

export default class ExamplePlugin extends Plugin {
  async onload() {
    addIcon('circle', `<circle cx="50" cy="50" r="50" fill="currentColor" />`);

    this.addRibbonIcon('circle', 'Click me', () => {
      console.log('Hello, you!');
    });
  }
}
addIcon takes two arguments:

A name to uniquely identify your icon.
The SVG content for the icon, without the surrounding <svg> tag.
Note that your icon needs to fit within a 0 0 100 100 view box to be drawn properly.

After the call to addIcon, you can use the icon just like any of the built-in icons.

Icon design guidelines 
For compatibility and cohesiveness with the Obsidian interface, your icons should follow Lucide’s guidelines:

Icons must be designed on a 24 by 24 pixels canvas
Icons must have at least 1 pixel padding within the canvas
Icons must have a stroke width of 2 pixels
Icons must use round joins
Icons must use round caps
Icons must use centered strokes
Shapes (such as rectangles) in icons must have border radius of 2 pixels
Distinct elements must have 2 pixels of spacing between each other
Lucide also provides templates and guides for vector editors such as Illustrator, Figma, and Inkscape.

---

Modals
Modals display information and accept user input. To create a modal, create a class that extends Modal:

import { App, Modal } from 'obsidian';

export class ExampleModal extends Modal {
  constructor(app: App) {
    super(app);
	this.setContent('Look at me, I\'m a modal! 👀')
  }
}
To open a modal, create a new instance of ExampleModal and call open() on it:

import { Plugin } from 'obsidian';
import { ExampleModal } from './modal';

export default class ExamplePlugin extends Plugin {
  async onload() {
    this.addCommand({
      id: 'display-modal',
      name: 'Display modal',
      callback: () => {
        new ExampleModal(this.app).open();
      },
    });
  }
}
Accept user input 
Our modal in the previous example only displayed some information. Let's look at a slightly more complex example that also handles user input.

modal-input.png

import { App, Modal, Setting } from 'obsidian';

export class ExampleModal extends Modal {
  constructor(app: App, onSubmit: (result: string) => void) {
    super(app);
	this.setTitle('What\'s your name?');

	let name = '';
    new Setting(this.contentEl)
      .setName('Name')
      .addText((text) =>
        text.onChange((value) => {
          name = value;
        }));

    new Setting(this.contentEl)
      .addButton((btn) =>
        btn
          .setButtonText('Submit')
          .setCta()
          .onClick(() => {
            this.close();
            onSubmit(name);
          }));
  }
}
The result is passed into the onSubmit callback when the user clicks Submit:

new ExampleModal(this.app, (result) => {
  new Notice(`Hello, ${result}!`);
}).open();
Select from list of suggestions 
SuggestModal is a special modal that lets you display a list of suggestions to the user.

suggest-modal.gif

import { App, Notice, SuggestModal } from 'obsidian';

interface Book {
  title: string;
  author: string;
}

const ALL_BOOKS = [
  {
    title: 'How to Take Smart Notes',
    author: 'Sönke Ahrens',
  },
  {
    title: 'Thinking, Fast and Slow',
    author: 'Daniel Kahneman',
  },
  {
    title: 'Deep Work',
    author: 'Cal Newport',
  },
];

export class ExampleModal extends SuggestModal<Book> {
  // Returns all available suggestions.
  getSuggestions(query: string): Book[] {
    return ALL_BOOKS.filter((book) =>
      book.title.toLowerCase().includes(query.toLowerCase())
    );
  }

  // Renders each suggestion item.
  renderSuggestion(book: Book, el: HTMLElement) {
    el.createEl('div', { text: book.title });
    el.createEl('small', { text: book.author });
  }

  // Perform action on the selected suggestion.
  onChooseSuggestion(book: Book, evt: MouseEvent | KeyboardEvent) {
    new Notice(`Selected ${book.title}`);
  }
}
Approximate string matching results 
In addition to SuggestModal, the Obsidian API provides an even more specialized type of modal for suggestions: the FuzzySuggestModal, which gets you fuzzy string search out-of-the-box.

fuzzy-suggestion-modal.png

import {FuzzySuggestModal, Notice} from "obsidian";

export class ExampleSuggestModal extends FuzzySuggestModal<Book> {
  getItems(): Book[] {
    return ALL_BOOKS;
  }

  getItemText(book: Book): string {
    return book.title;
  }

  onChooseItem(book: Book, evt: MouseEvent | KeyboardEvent) {
    new Notice(`Selected ${book.title}`);
  }
}
Custom rendering of fuzzy search results 
For a more custom UI you implement the renderSuggestion function, like in the earlier example.
The renderResults method is responsible for rendering the different strings while highlighting the matched parts.

fuzzy-suggestion-custom-modal.png

import {FuzzyMatch, FuzzySuggestModal, Notice, renderResults} from "obsidian";

export class ExampleSuggestModal extends FuzzySuggestModal<Book> {  
  
    //return a string representation, so there is something to search  
    getItemText(item: Book): string {  
       return item.title + " " + item.author;  
    }  
  
    getItems(): Book[] {  
       return ALL_BOOKS;  
    }  
  
    renderSuggestion(match: FuzzyMatch<Book>, el: HTMLElement) {  
       const titleEl = el.createDiv();  
       renderResults(titleEl, match.item.title, match.match);  
  
       // Only render the matches in the author name.  
       const authorEl = el.createEl('small');  
       const offset = -(match.item.title.length + 1);  
       renderResults(authorEl, match.item.author, match.match, offset);  
    }  
  
    onChooseItem(book: Book, evt: MouseEvent | KeyboardEvent): void {  
       new Notice(`Selected ${book.title}`);  
    }  
  
}

---

===ADVANCED===

Build a Bases view
Bases is a core plugin in Obsidian which display dynamic views of your notes as tables, cards, lists, and more. If you're unfamiliar with Bases, please read about them in the help docs before getting started.

Plugins can use the Obsidian API to create completely custom views of the data powering Bases. In this guide, you'll walk through extending the sample plugin to create a simplified version of the list view.

What you'll learn 
After you've completed this guide, you'll be able to:

Create a custom Bases view.
Dynamically render data from note properties in a list format.
Prerequisites 
To complete this guide, you'll need:

Git installed on your local machine.
A local development environment for Node.js.
A code editor, such as Visual Studio Code.
Additionally, this guide will build off of the sample plugin created in a previous guide. Follow the Build a plugin guide before starting this guide.

Before you start 
When developing plugins, one mistake can lead to unintended changes to your vault. To prevent data loss, you should never develop plugins in your main vault. Always use a separate vault dedicated to plugin development.

Create an empty vault.

Step 1: Sample plugin setup 
In this guide it is assumed that you have a directory on your computer with the sample plugin and that you know how to build your plugin and test it in Obsidian.

For the purposes of this list view plugin, we can remove a large portion of the code from the MyPlugin class, leaving just the onload function.

export default class MyPlugin extends Plugin {
  async onload() {
  }
}
Step 2: Create and register the Bases view 
Once you have an empty plugin which can be built and loaded into Obsidian, you can begin building a Bases view. Start with a view that statically displays "Hello World".

export const ExampleViewType = 'example-view';

export default class MyPlugin extends Plugin {
  async onload() {
    // Tell Obsidian about the new view type that this plugin provides.
    this.registerBasesView(ExampleViewType, {
      name: 'Example',
      icon: 'lucide-graduation-cap',
      factory: (controller, containerEl) => {
        new MyBasesView(controller, containerEl)
      },
    });
  }
}

export class MyBasesView extends BasesView {
  readonly type = ExampleViewType;
  private containerEl: HTMLElement;

  constructor(controller: QueryController, parentEl: HTMLElement) {
    super(controller);
    this.containerEl = parentEl.createDiv('bases-example-view-container');
  }

  // onDataUpdated is called by Obsidian whenever there is a configuration
  // or data change in the vault which may affect your view. For now,
  // simply draw "Hello World" to screen.
  public onDataUpdated(): void {
    this.containerEl.empty();
    this.containerEl.createDiv({ text: 'Hello World' });
  }
}
Build your plugin, reload the app, and create a new Base file. Use the menu on the left of the toolbar, and select the right chevron next to the view in the list. From this menu, change the layout to your newly created "Example" view type.

Step 3: Add configuration 
The menu where you changed the view layout can also contain additional configuration options for your view. Add an options property in the call to registerBasesView.

In your IDE, you can view the definition of ViewOption to see the different controls available. Each control will create an entry in the view configuration menu, and user input will automatically be stored in the Bases configuration file.

export default class MyPlugin extends Plugin {
  async onload() {
    // Tell Obsidian about the new view type that this plugin provides.
    this.registerBasesView(ExampleViewType, {
      name: "Example",
      icon: 'lucide-graduation-cap',
      factory: (controller, containerEl) => {
        new MyBasesView(controller, containerEl)
      },
      options: () => ([
        {
          // The type of option. 'text' is a text input.
          type: 'text',
          // The name displayed in the settings menu.
          displayName: 'Property separator',
          // The value saved to the view settings.
          key: 'separator',
          // The default value for this option.
          default: ' - ',
        },
        // ...
    ]),
    });
  }
}
example-bases-view-configuration.gif > interface

Step 4: Display list items 
The final step in creating a new Bases view is to transform the data from properties into the format you want to display. Obsidian will call the onDataUpdated method on your view whenever there are changes to the data. To keep this example simple, the code below clears the container, and rerenders a list entry for every file provided in the data set. It is important, however, to keep in mind the best practices of web development. An unfiltered Base will provide an entry for every file in the vault, so your view should be able to handle thousands of entries, reuse DOM elements, and avoid rendering off screen where appropriate.

// Add `implements HoverParent` to enable hovering over file links.
export class MyBasesView extends BasesView implements HoverParent {

  hoverPopover: HoverPopover | null;

  // ...

  public onDataUpdated(): void {
    const { app } = this;

    // Retrieve the user configured order set in the Properties menu.
    const order = this.config.getOrder()

    // Clear entries created by previous iterations. Remember, you should
    // instead attempt element reuse when possible.
    this.containerEl.empty();

    // The property separator configured by the ViewOptions above can be
    // retrieved from the view config. Be sure to set a default value.
    const propertySeparator = String(this.config.get('separator')) || ' - ';

    // this.data contains both grouped and ungrouped versions of the data.
    // If it's appropriate for your view type, use the grouped form.
    for (const group of this.data.groupedData) {
      const groupEl = this.containerEl.createDiv('bases-list-group');
      const groupListEl = groupEl.createEl('ul', 'bases-list-group-list');

      // Each entry in the group is a separate file in the vault matching
      // the Base filters. For list view, each entry is a separate line.
      for (const entry of group.entries) {
        groupListEl.createEl('li', 'bases-list-entry', (el) => {
          let firstProp = true;
          for (const propertyName of order) {
            // Properties in the order can be parsed to determine what type
            // they are: formula, note, or file.
            const { type, name } = parsePropertyId(propertyName);
  
            // `entry.getValue` returns the evaluated result of the property
            // in the context of this entry.
            const value = entry.getValue(propertyName);
  
            // Skip rendering properties which have an empty value.
            // The list items for each file may have differing length.
            if (value.isEmpty()) continue;
  
            if (!firstProp) {
              el.createSpan({
                cls: 'bases-list-separator',
                text: propertySeparator
              });
            }
            firstProp = false;
  
            // If the `file.name` property is included in the order, render
            // it specially so that it links to that file.
            if (name === 'name' && type === 'file') {
              const fileName = String(entry.file.name);
              const linkEl = el.createEl('a', { text: fileName });
              linkEl.onClickEvent((evt) => {
                if (evt.button !== 0 && evt.button !== 1) return;
                evt.preventDefault();
                const path = entry.file.path;
                const modEvent = Keymap.isModEvent(evt);
                void app.workspace.openLinkText(path, '', modEvent);
              });
  
              linkEl.addEventListener('mouseover', (evt) => {
                app.workspace.trigger('hover-link', {
                  event: evt,
                  source: 'bases',
                  hoverParent: this,
                  targetEl: linkEl,
                  linktext: entry.file.path,
                });
              });
            }
            // For all other properties, just display the value as text.
            // In your view you may also choose to use the `Value.renderTo`
            // API to better support photos, links, icons, etc.
            else {
              el.createSpan({
                cls: 'bases-list-entry-property',
                text: value.toString()
              });
            }
          }
        });
      }
    }
  }
}
Rebuild your plugin and reload the app. Your Base should now display a list item for every file in the vault!

Conclusion 
Congratulations on building your first Bases view! Bases are a powerful new way to view the data in your vault and we can't wait to see what new views you create.

--- 