/* globals Node, HTMLUnknownElement */
const Expr = require('./expr');
const Filter = require('./filter');
const Binding = require('./binding');
const Accessor = require('./accessor');
const Annotation = require('./annotation');
const Token = require('./token');
const Serializer = require('./serializer');

const SLOT_SUPPORTED = 'HTMLUnknownElement' in window && !(document.createElement('slot') instanceof HTMLUnknownElement);

let templateId = 0;

function nextId () {
  return templateId++;
}

function slotName (element) {
  return SLOT_SUPPORTED ? element.name : element.getAttribute('name');
}

function slotAppend (slot, node, root) {
  if (!slot.__slotHasChildren) {
    slot.__slotHasChildren = true;
    slot.__slotFallbackContent = slot.innerHTML;
    slot.innerHTML = '';
  }

  slot.appendChild(node);
}

function elementSlot (element) {
  return SLOT_SUPPORTED ? element.slot : element.getAttribute('slot');
}

function fixTemplate (template) {
  if (!template.content && window.HTMLTemplateElement && window.HTMLTemplateElement.decorate) {
    window.HTMLTemplateElement.decorate(template);
  }
  return template;
}

function T (template, host, marker) {
  this.__templateInitialize(template, host, marker);
}

T.prototype = {
  get $ () {
    return this.__templateHost.getElementsByTagName('*');
  },

  __templateInitialize (template, host, marker) {
    this.__templateId = nextId();
    this.__templateBindings = {};
    this.__templateHost = host || (template ? template.parentElement : null);
    this.__templateMarker = marker;

    if (!template) {
      return;
    }

    // do below only if template is exists
    this.__template = fixTemplate(template);
    this.__templateFragment = document.importNode(this.__template.content, true);
    this.__templateChildNodes = [].slice.call(this.__templateFragment.childNodes);
    this.__parseAnnotations();

    if (marker) {
      return;
    }

    if (this.__template.parentElement === this.__templateHost) {
      // when template parent is template host, it means that template is specific template
      // then use template as marker
      this.__templateMarker = this.__template;
    } else {
      // when template is not child of host, put marker to host
      this.__templateMarker = document.createComment(`marker-${this.__templateId}`);
      this.__templateHost.appendChild(this.__templateMarker);
    }
  },

  $$ (selector) {
    return this.querySelector(selector);
  },

  render (content) {
    if (!this.__template) {
      return;
    }

    if (content) {
      try {
        [].forEach.call(this.__templateFragment.querySelectorAll('slot'), slot => {
          let name = slotName(slot);
          if (name) {
            content.forEach(node => {
              if (node.nodeType === Node.ELEMENT_NODE && name === elementSlot(node)) {
                slotAppend(slot, node, this.__templateFragment);
              }
              // TODO query to childnodes looking for slot
            });
          } else {
            content.forEach(node => {
              slotAppend(slot, node, this.__templateFragment);
            });
          }
        });
      } catch (err) {
        console.error(err.stack);
        throw err;
      }
    }

    this.__templateMarker.parentElement.insertBefore(this.__templateFragment, this.__templateMarker);
  },

  __templateUninitialize () {
    this.__templateChildNodes.forEach(node => {
      node.parentElement.removeChild(node);
    });
  },

  all (obj) {
    for (let i in obj) {
      if (obj.hasOwnProperty(i)) {
        this.set(i, obj[i]);
      }
    }
  },

  __templateGetPathAsArray (path) {
    if (!path) {
      throw new Error(`Unknown path ${path} to set to ${this.is}`);
    }

    if (typeof path !== 'string') {
      return path;
    }

    return path.split('.');
  },

  __templateGetPathAsString (path) {
    if (typeof path === 'string') {
      return path;
    }

    return path.join('.');
  },

  get (path) {
    let object = this;

    this.__templateGetPathAsArray(path).some(segment => {
      if (object === undefined || object === null) {
        object = undefined;
        return true;
      }

      object = object[segment];
      return false;
    });

    return object;
  },

  set (path, value) {
    path = this.__templateGetPathAsArray(path);

    let oldValue = this.get(path);

    if (value === oldValue) {
      return;
    }

    let object = this;

    path.slice(0, -1).forEach(segment => {
      if (!object) {
        return;
      }
      if (object[segment] === undefined || object[segment] === null) {
        object[segment] = {};
      }

      object = object[segment];
    });

    let property = path.slice(-1).pop();

    object[property] = value;

    this.notify(path, value);
  },

  notify (path, value) {
    path = this.__templateGetPathAsString(path);

    // console.log(this.__getId(), '<notify>', path, '?', value, `<${typeof value}>`);

    try {
      let binding = this.__templateGetBinding(path);
      if (binding) {
        binding.walkEffect(value);
      }
    } catch (err) {
      console.warn(`#notify caught error: ${err.message}\n Stack trace: ${err.stack}`);
    }
  },

  __parseAnnotations () {
    // this.__templateAnnotatedElements = [];

    let len = this.__templateFragment.childNodes.length;
    for (let i = 0; i < len; i++) {
      let node = this.__templateFragment.childNodes[i];
      switch (node.nodeType) {
        case Node.ELEMENT_NODE:
          this.__parseElementAnnotations(node);
          break;
        case Node.TEXT_NODE:
          this.__parseTextAnnotations(node);
          break;
      }
    }

    Object.keys(this.__templateBindings).forEach(key => {
      this.notify(key, this.get(key));
    });
  },

  __parseEventAnnotations (element, attrName) {
    // bind event annotation
    let attrValue = element.getAttribute(attrName);
    let eventName = attrName.slice(1, -1);
    // let eventName = attrName.substr(3);
    if (eventName === 'tap') {
      eventName = 'click';
    }

    let context = this;
    let expr = Expr.getFn(attrValue, [], true);

    // console.log(this, element);
    // TODO might be slow or memory leak setting event listener to inside element
    element.addEventListener(eventName, function (evt) {
      return expr.invoke(context, { evt });
    }, true);
  },

  __parseAttributeAnnotations (element) {
    // clone attributes to array first then foreach because we will remove
    // attribute later if already processed
    // this hack to make sure when attribute removed the attributes index doesnt shift.
    return [].slice.call(element.attributes).reduce((annotated, attr) => {
      let attrName = attr.name;

      if (attrName.indexOf('(') === 0) {
        this.__parseEventAnnotations(element, attrName);
      } else {
        // bind property annotation
        annotated = this.__templateAnnotate(Expr.get(attr.value), Accessor.get(element, attrName)) || annotated;
      }

      return annotated;
    }, false);
  },

  __parseElementAnnotations (element) {
    let annotated = false;
    let scoped = element.__templateModel;

    if (scoped) {
      return annotated;
    }

    // element.classList.add(`${this.__templateHost.is || 'template'}__scope`);
    element.__templateModel = this;

    if (element.attributes && element.attributes.length) {
      annotated = this.__parseAttributeAnnotations(element) || annotated;
    }

    if (element.childNodes && element.childNodes.length) {
      let childNodes = [].slice.call(element.childNodes);
      let childNodesLength = childNodes.length;

      for (let i = 0; i < childNodesLength; i++) {
        annotated = this.__parseNodeAnnotations(childNodes[i]) || annotated;
      }
    }

    [].forEach.call(element.getElementsByTagName('slot'), slot => {
      [].forEach.call(slot.childNodes, node => {
        annotated = this.__parseNodeAnnotations(node) || annotated;
      });
    });

    return annotated;
  },

  __parseNodeAnnotations (node) {
    switch (node.nodeType) {
      case Node.TEXT_NODE:
        return this.__parseTextAnnotations(node);
      case Node.ELEMENT_NODE:
        return this.__parseElementAnnotations(node);
    }
  },

  __parseTextAnnotations (node) {
    let expr = Expr.get(node.textContent);

    let accessor;
    if (node.parentElement && node.parentElement.nodeName === 'TEXTAREA') {
      accessor = Accessor.get(node.parentElement, 'value');
    } else {
      accessor = Accessor.get(node);
    }

    return this.__templateAnnotate(expr, accessor);
  },

  __templateAnnotate (expr, accessor) {
    if (expr.type === 's') {
      return false;
    }

    if (expr.constant) {
      accessor.set(expr.invoke(this));
      return false;
    }

    // annotate every paths
    let annotation = new Annotation(this, expr, accessor);

    expr.vpaths.forEach(arg => this.__templateGetBinding(arg.name).annotations.push(annotation));

    return true;
  },

  __templateGetBinding (path) {
    let segments = path.split('.');
    let bindings;
    let binding;

    for (let i = 0; i < segments.length; i++) {
      let segment = segments[i];

      bindings = binding ? binding.paths : this.__templateBindings;

      if (!bindings[segment]) {
        bindings[segment] = new Binding(this, segment);
      }

      binding = bindings[segment];
    }

    return binding;
  },
};

if (typeof window === 'object') {
  window.T = T;
}

module.exports = T;
module.exports.Filter = Filter;
module.exports.Accessor = Accessor;
module.exports.Expr = Expr;
module.exports.Token = Token;
module.exports.Serializer = Serializer;
