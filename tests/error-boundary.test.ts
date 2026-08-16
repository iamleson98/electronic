import { describe, it, expect } from 'vitest';
import React from 'react';
import { ErrorBoundary, withErrorBoundary, reportError } from '../src/components/ErrorBoundary';
describe('ErrorBoundary', () => {
  it('getDerivedStateFromError: sets hasError', () => { const s=ErrorBoundary.getDerivedStateFromError(new Error('test'));expect(s.hasError).toBe(true);});
  it('render: returns children when no error', () => { const b=new (ErrorBoundary as any)({name:'Test'});b.props={name:'Test',children:React.createElement('div')};b.state={hasError:false,error:null,errorInfo:null,showDetails:false,errorCount:0};const r=b.render();expect(r).toBe(b.props.children);});
  it('render: returns fallback when error', () => { const b=new (ErrorBoundary as any)({name:'Test'});b.props={name:'Test',children:React.createElement('div')};b.state={hasError:true,error:new Error('test'),errorInfo:null,showDetails:false,errorCount:1};const r=b.render() as React.ReactElement;expect(r).not.toBe(b.props.children);});
  it('withErrorBoundary: returns function', () => { const C=(p:any)=>React.createElement('div');const W=withErrorBoundary(C,{name:'Test'});expect(typeof W).toBe('function');});
  it('reportError: does not crash', () => { expect(()=>reportError(new Error('test'),{componentStack:''})).not.toThrow();});
});
