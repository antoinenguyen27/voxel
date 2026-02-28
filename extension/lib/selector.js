(function () {
  function escapeCssValue(value) {
    if (typeof CSS !== 'undefined' && CSS && typeof CSS.escape === 'function') {
      return CSS.escape(value);
    }
    return String(value).replace(/(["\\#.:\[\]\(\)])/g, '\\$1');
  }

  function buildNthChildPath(el) {
    var parts = [];
    var node = el;

    while (node && node !== document.body) {
      var parent = node.parentNode;
      if (!parent || !node.tagName) {
        break;
      }
      var tag = node.tagName.toLowerCase();
      var siblings = Array.prototype.filter.call(parent.children || [], function (s) {
        return s.tagName === node.tagName;
      });
      var idx = siblings.indexOf(node) + 1;
      parts.unshift(siblings.length > 1 ? tag + ':nth-of-type(' + idx + ')' : tag);
      node = parent;
    }

    return parts.length > 0 ? parts.join(' > ') : null;
  }

  window.__getStableSelector = function (el) {
    try {
      if (!el || el.nodeType !== 1) {
        return null;
      }

      var tag = el.tagName.toLowerCase();
      var ariaLabel = el.getAttribute('aria-label');
      if (ariaLabel) {
        var ariaCandidate = tag + '[aria-label="' + escapeCssValue(ariaLabel) + '"]';
        if (document.querySelectorAll(ariaCandidate).length === 1) {
          return ariaCandidate;
        }
      }

      var attrs = Array.prototype.slice.call(el.attributes || []);
      for (var i = 0; i < attrs.length; i += 1) {
        var attr = attrs[i];
        if (
          attr &&
          attr.name &&
          attr.name.indexOf('data-') === 0 &&
          (attr.name.indexOf('id') !== -1 || attr.name.indexOf('key') !== -1 || attr.name.indexOf('testid') !== -1)
        ) {
          var dataCandidate = '[' + attr.name + '="' + escapeCssValue(attr.value) + '"]';
          if (document.querySelectorAll(dataCandidate).length === 1) {
            return dataCandidate;
          }
        }
      }

      if (el.id && !/\d{5,}/.test(el.id) && el.id.indexOf(':') === -1) {
        var idCandidate = '#' + escapeCssValue(el.id);
        if (document.querySelectorAll(idCandidate).length === 1) {
          return idCandidate;
        }
      }

      var role = el.getAttribute('role');
      var name = el.getAttribute('name') || el.getAttribute('placeholder');
      if (role && name) {
        var roleCandidate = '[role="' + escapeCssValue(role) + '"][name="' + escapeCssValue(name) + '"]';
        if (document.querySelectorAll(roleCandidate).length === 1) {
          return roleCandidate;
        }
      }

      var stableClasses = Array.prototype.filter.call(el.classList || [], function (c) {
        return !/\d{3,}/.test(c) && c.length < 40;
      }).slice(0, 3);

      if (stableClasses.length > 0) {
        var classCandidate = tag + '.' + stableClasses.join('.');
        if (document.querySelectorAll(classCandidate).length === 1) {
          return classCandidate;
        }
      }

      return buildNthChildPath(el);
    } catch (_err) {
      return null;
    }
  };
})();
