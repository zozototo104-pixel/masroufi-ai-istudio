import React, { useEffect, useRef } from 'react';
import * as d3 from 'd3';

interface MindMapChartProps {
  transactions: any[];
}

export default function MindMapChart({ transactions }: MindMapChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!containerRef.current) return;
    
    // Clear previous SVG
    d3.select(containerRef.current).selectAll('*').remove();

    const expenses = transactions.filter(t => t.type === 'expense');
    
    // If no expenses, show a placeholder
    if (expenses.length === 0) {
      const p = document.createElement('div');
      p.className = "flex items-center justify-center h-full text-slate-500 text-sm";
      p.innerText = "لا توجد مصروفات لرسم خريطة العقل.";
      containerRef.current.appendChild(p);
      return;
    }

    const width = containerRef.current.clientWidth;
    const height = containerRef.current.clientHeight || 400;

    // Build hierarchy data
    // Root -> Category -> Subcategory/Merchant
    const grouped = d3.group(expenses, d => d.category || 'أخرى', d => d.subcategory || d.merchant || 'تفاصيل');
    
    const rootData = {
      id: "root",
      name: "إجمالي المصروفات",
      amount: d3.sum(expenses, d => d.amount),
      children: Array.from(grouped, ([category, subGroup]) => ({
        id: `cat-${category}`,
        name: category,
        amount: d3.sum(Array.from(subGroup.values()).flat(), d => d.amount),
        children: Array.from(subGroup, ([sub, items]) => ({
          id: `sub-${category}-${sub}`,
          name: sub,
          amount: d3.sum(items, d => d.amount)
        }))
      }))
    };

    // Flatten to nodes and links
    const nodes: any[] = [];
    const links: any[] = [];

    const rootNode = { id: rootData.id, name: rootData.name, group: 0, val: Math.sqrt(rootData.amount) * 2 || 20 };
    nodes.push(rootNode);

    rootData.children.forEach(cat => {
      const catNode = { id: cat.id, name: cat.name, group: 1, val: Math.sqrt(cat.amount) * 2 || 15 };
      nodes.push(catNode);
      links.push({ source: rootNode.id, target: catNode.id });

      cat.children.forEach(sub => {
        const subNode = { id: sub.id, name: sub.name, group: 2, val: Math.sqrt(sub.amount) * 2 || 10 };
        nodes.push(subNode);
        links.push({ source: catNode.id, target: subNode.id });
      });
    });

    const svg = d3.select(containerRef.current)
      .append('svg')
      .attr('width', width)
      .attr('height', height)
      .attr('viewBox', [-width / 2, -height / 2, width, height]);

    // Add subtle glow filter
    const defs = svg.append("defs");
    const filter = defs.append("filter").attr("id", "glow");
    filter.append("feGaussianBlur").attr("stdDeviation", "3").attr("result", "coloredBlur");
    const feMerge = filter.append("feMerge");
    feMerge.append("feMergeNode").attr("in", "coloredBlur");
    feMerge.append("feMergeNode").attr("in", "SourceGraphic");

    const link = svg.append('g')
      .attr('stroke', '#334155')
      .attr('stroke-opacity', 0.6)
      .selectAll('line')
      .data(links)
      .join('line')
      .attr('stroke-width', 2);

    const color = d3.scaleOrdinal()
      .domain(['0', '1', '2'])
      .range(['#10b981', '#3b82f6', '#f43f5e']);

    const drag = (simulation: any) => {
      function dragstarted(event: any, d: any) {
        if (!event.active) simulation.alphaTarget(0.3).restart();
        d.fx = d.x;
        d.fy = d.y;
      }
      function dragged(event: any, d: any) {
        d.fx = event.x;
        d.fy = event.y;
      }
      function dragended(event: any, d: any) {
        if (!event.active) simulation.alphaTarget(0);
        d.fx = null;
        d.fy = null;
      }
      return d3.drag()
        .on('start', dragstarted)
        .on('drag', dragged)
        .on('end', dragended);
    };

    const node = svg.append('g')
      .attr('stroke', '#0f172a')
      .attr('stroke-width', 2)
      .selectAll('g')
      .data(nodes)
      .join('g')
      .call(drag(d3.forceSimulation()) as any);

    node.append('circle')
      .attr('r', d => Math.max(d.val, 8))
      .attr('fill', d => color(String(d.group)) as string)
      .style('filter', 'url(#glow)');

    node.append('text')
      .text(d => d.name)
      .attr('x', 0)
      .attr('y', d => Math.max(d.val, 8) + 14)
      .attr('text-anchor', 'middle')
      .attr('fill', '#f8fafc')
      .attr('font-size', d => d.group === 0 ? '12px' : '10px')
      .attr('font-weight', d => d.group === 0 ? 'bold' : 'normal')
      .attr('stroke', 'none');

    const simulation = d3.forceSimulation(nodes)
      .force('link', d3.forceLink(links).id((d: any) => d.id).distance(60))
      .force('charge', d3.forceManyBody().strength(-200))
      .force('center', d3.forceCenter(0, 0))
      .force('collide', d3.forceCollide().radius((d: any) => Math.max(d.val, 8) + 20).iterations(2));

    simulation.on('tick', () => {
      link
        .attr('x1', d => (d.source as any).x)
        .attr('y1', d => (d.source as any).y)
        .attr('x2', d => (d.target as any).x)
        .attr('y2', d => (d.target as any).y);

      node.attr('transform', d => `translate(${d.x},${d.y})`);
    });
    
    // Apply initial drag config
    node.call(drag(simulation) as any);

    return () => {
      simulation.stop();
    };
  }, [transactions]);

  return <div ref={containerRef} className="w-full h-[400px]" />;
}
