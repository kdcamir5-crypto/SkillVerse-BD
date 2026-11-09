// SkillVerse BD — apply the saved theme (purple / blue / dark) on every page.
(function(){try{var p=JSON.parse(localStorage.getItem('skillverse_settings_v1')||'{}');document.documentElement.dataset.theme=p.theme||'blue'}catch(e){document.documentElement.dataset.theme='blue'}})();
