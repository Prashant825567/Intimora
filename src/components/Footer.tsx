import React from "react";
import { Shield, Lock, Eye } from "lucide-react";

const Footer: React.FC = () => {
  return (
    <footer className="border-t border-gray-900 mt-16 py-10 px-4" style={{ background: "#060606" }}>
      <div className="max-w-6xl mx-auto">
        {/* Logo row */}
        <div className="flex flex-col sm:flex-row items-center justify-between gap-6 mb-8">
          <div className="flex items-center gap-3">
            <img src="/logo.png" alt="Intimora" className="w-10 h-10 object-contain" />
            <div>
              <span className="text-xl font-black tracking-widest" style={{ color: "#c9a84c", fontFamily: "Georgia, serif" }}>
                INTIMORA
              </span>
              <p className="text-gray-600 text-xs tracking-wider">Premium Adult Entertainment</p>
            </div>
          </div>
          <div className="flex items-center gap-6">
            <div className="flex items-center gap-2 text-gray-600 text-xs">
              <Shield className="w-4 h-4 text-green-500" />
              <span>Content Safety</span>
            </div>
            <div className="flex items-center gap-2 text-gray-600 text-xs">
              <Lock className="w-4 h-4 text-blue-500" />
              <span>Privacy Matters</span>
            </div>
            <div className="flex items-center gap-2 text-gray-600 text-xs">
              <Eye className="w-4 h-4 text-yellow-500" />
              <span>Adults Only</span>
            </div>
          </div>
        </div>

        {/* Links */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-6 mb-8 text-sm">
          {[
            { title: "Company", links: ["About Us", "Careers", "Press", "Contact"] },
            { title: "Legal", links: ["Terms of Service", "Privacy Policy", "Cookie Policy", "DMCA"] },
            { title: "Safety", links: ["Safety Center", "Report Abuse", "2257 Statement", "Age Verification"] },
            { title: "Platform", links: ["Become a Creator", "Premium Plans", "Help Center", "API"] },
          ].map((col) => (
            <div key={col.title}>
              <h4 className="text-yellow-600 font-bold text-xs tracking-widest uppercase mb-3">{col.title}</h4>
              <ul className="space-y-2">
                {col.links.map((link) => (
                  <li key={link}>
                    <a href="#" className="text-gray-600 hover:text-gray-400 transition text-xs">
                      {link}
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        {/* Disclaimer */}
        <div className="border-t border-gray-900 pt-6 text-center">
          <div
            className="inline-block px-4 py-2 rounded-lg border border-red-900/30 bg-red-900/10 mb-4"
          >
            <p className="text-red-400 text-xs font-semibold">
              🔞 ADULTS ONLY – This website contains explicit adult content. You must be 18 years of age or older to access this site.
            </p>
          </div>
          <p className="text-gray-700 text-xs leading-relaxed max-w-2xl mx-auto">
            All models on this website were 18+ at the time of filming. All content is fictional and produced legally. 
            Intimora complies with 18 U.S.C. 2257. © {new Date().getFullYear()} Intimora. All Rights Reserved.
          </p>
          <p className="text-gray-800 text-xs mt-3">
            Unauthorized reproduction or distribution of any content on this website is strictly prohibited.
          </p>
        </div>
      </div>
    </footer>
  );
};

export default Footer;
