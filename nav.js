// SkillVerse BD — shared bottom navigation. Usage: <script src="nav.js" data-active="home"></script>
(function(){
  var active=(document.currentScript&&document.currentScript.dataset.active)||'';
  var I={
    home:'<path d="M3 11.5 12 4l9 7.5"/><path d="M5 10v10h14V10"/>',
    pdf:'<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/>',
    plus:'<path d="M12 5v14M5 12h14"/>',
    rank:'<path d="M8 21h8M12 17v4M7 4h10v5a5 5 0 0 1-10 0z"/><path d="M7 6H4v2a3 3 0 0 0 3 3M17 6h3v2a3 3 0 0 1-3 3"/>',
    profile:'<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>'
  };
  var items=[['home','Home','index.html'],['pdf','PDF','pdf.html'],['plus','','scanner.html'],['rank','Rank','rank.html'],['profile','Profile','profile.html']];
  var nav=document.createElement('nav');nav.className='sv-nav';nav.setAttribute('aria-label','Main navigation');
  nav.innerHTML='<div class="sv-nav-in">'+items.map(function(x){
    var cls=x[0]==='plus'?'plus':(x[0]===active?'on':'');
    return '<button class="'+cls+'" aria-label="'+(x[1]||'Scan')+'" onclick="location.href=\''+x[2]+'\'"><svg viewBox="0 0 24 24">'+I[x[0]]+'</svg>'+(x[1]?x[1]:'')+'</button>';
  }).join('')+'</div>';
  document.body.appendChild(nav);
  var t=document.createElement('script');t.type='module';t.src='tracker.js';document.head.appendChild(t);
})();
